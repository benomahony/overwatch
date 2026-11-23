"""Every workflow step that runs the TLA+ tools jar must follow a download that runs whenever the step does."""
import re
import unittest

from paths import ROOT

WORKFLOW = ROOT / '.github/workflows/test.yml'
JAR = 'tla2tools.jar'
JOB_HEADER = re.compile(r'^  (\w[\w-]*):\s*$')
STEP_START = re.compile(r'^      - ')
CONDITION = re.compile(r'^(?:      - |        )if:\s*(.+?)\s*$')


def jobs_with_steps(text: str) -> dict[str, list[dict]]:
    """Steps of each job, in order, as their raw text and `if:` condition, without a YAML parser."""
    jobs: dict[str, list[dict]] = {}
    in_jobs = False
    for line in text.splitlines():
        if line == 'jobs:':
            in_jobs = True
        elif in_jobs and (header := JOB_HEADER.match(line)):
            steps = jobs.setdefault(header.group(1), [])
        elif in_jobs and STEP_START.match(line):
            steps.append({'text': '', 'condition': None})
        if in_jobs and jobs and steps:
            steps[-1]['text'] += line + '\n'
            if condition := CONDITION.match(line):
                steps[-1]['condition'] = condition.group(1)
    return jobs


def workflow_jobs() -> dict[str, list[dict]]:
    return jobs_with_steps(WORKFLOW.read_text())


def downloads_jar(step: dict) -> bool:
    return 'curl' in step['text'] and JAR in step['text']


def unmet_jar_users(jobs: dict[str, list[dict]]) -> list[str]:
    """Names of steps that use the jar with no earlier download that is unconditional or has their condition."""
    unmet = []
    for job, steps in jobs.items():
        for index, step in enumerate(steps):
            if JAR not in step['text'] or downloads_jar(step):
                continue
            covered = any(downloads_jar(earlier) and earlier['condition'] in (None, step['condition'])
                          for earlier in steps[:index])
            if not covered:
                unmet.append(f"{job}: {step['text'].splitlines()[0].strip()}")
    return unmet


class WorkflowJarTest(unittest.TestCase):
    def test_every_step_using_the_jar_follows_a_download_that_runs_with_it(self):
        jobs = workflow_jobs()
        users = [step for steps in jobs.values() for step in steps if JAR in step['text']]
        self.assertGreaterEqual(len(users), 4, f'The parser found {len(users)} steps using {JAR}; it lost some')
        self.assertEqual(unmet_jar_users(jobs), [])

    def test_a_conditional_download_does_not_cover_an_unconditional_step(self):
        jobs = jobs_with_steps(
            "jobs:\n  check:\n    steps:\n"
            "      - name: Download\n        if: steps.spec.outputs.changed == 'true'\n"
            "        run: curl -o \"$RUNNER_TEMP/tla2tools.jar\" https://example.test/tla2tools.jar\n"
            "      - name: Check\n        run: python3 check.py --jar \"$RUNNER_TEMP/tla2tools.jar\"\n")
        self.assertEqual(unmet_jar_users(jobs), ['check: - name: Check'])

    def test_a_download_with_the_same_condition_covers_the_step(self):
        jobs = jobs_with_steps(
            "jobs:\n  check:\n    steps:\n"
            "      - name: Download\n        if: always()\n"
            "        run: curl -o \"$RUNNER_TEMP/tla2tools.jar\" https://example.test/tla2tools.jar\n"
            "      - name: Check\n        if: always()\n        run: python3 check.py --jar \"$RUNNER_TEMP/tla2tools.jar\"\n")
        self.assertEqual(unmet_jar_users(jobs), [])


if __name__ == '__main__':
    unittest.main()
