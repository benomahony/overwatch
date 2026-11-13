"""Behavior descriptions bind each implemented step to the real hook acceptance fixture."""
from .dsl import Scenario
from .world import AcceptanceWorld as World


SCENARIOS = (
    Scenario("Claude stops repeating corrections when no work occurs", "Claude retry limits", ("claude", "completion", "retry-loop"))
    .given("A previously passing Claude watcher now reports warnings", World.claude_new_failure)
    .when("The correction turns repeatedly finish without using tools", World.claude_empty_corrections)
    .then("Only one correction is requested while completion and publication stay guarded", World.claude_loop_stops),

    Scenario("Inspecting in a correction turn does not repeat the correction", "Claude retry limits", ("claude", "completion", "retry-loop", "inspection"))
    .given("A previously passing Claude watcher now reports warnings", World.claude_new_failure)
    .when("Each correction turn reads files and runs the check, and the warnings do not change", World.claude_inspecting_corrections)
    .then("Only one correction is requested", World.claude_inspection_does_not_repeat),

    Scenario("Another process's changes give Claude at most one correction", "Claude retry limits", ("claude", "completion", "retry-loop", "outside-changes"))
    .given("A Claude session whose checks are clean and which makes no edits", World.claude_clean_session)
    .when("Another process changes files several times, so the check fails with a different count each time", World.claude_outside_changes)
    .then("The session receives at most one correction, none says the failures came after its latest change, and completion stays guarded", World.claude_outside_changes_correct_once),

    Scenario("Denied publication does not restart Claude corrections", "Claude retry limits", ("claude", "completion", "protected-actions"))
    .given("A previously passing Claude watcher now reports warnings", World.claude_new_failure)
    .when("An empty correction remains guarded and publication is repeatedly denied", World.claude_denied_tools)
    .then("Publication never executes and no further correction is submitted", World.claude_denials_do_not_restart),

    Scenario("Claude requests a fresh correction after work resumes", "Claude recovery and changed findings", ("claude", "completion", "repair"))
    .given("A previously passing Claude watcher now reports warnings", World.claude_new_failure)
    .when("An empty correction remains guarded and the agent resumes inspection in a new turn", World.claude_work_resumes)
    .then("Inspection succeeds and the remaining warnings request another correction", World.claude_correction_resumes),

    Scenario("Changed findings give Claude one fresh correction", "Claude recovery and changed findings", ("claude", "completion", "new-findings"))
    .given("A previously passing Claude watcher now reports warnings", World.claude_new_failure)
    .when("An empty correction remains guarded and the agent's next edit adds warnings", World.claude_findings_change)
    .then("The new warnings request one fresh correction and empty retries remain guarded", World.claude_changed_findings_get_one_correction),

    Scenario("Passing checks release a queued Claude correction", "Claude recovery and changed findings", ("claude", "completion", "recovery"))
    .given("A previously passing Claude watcher now reports warnings", World.claude_new_failure)
    .when("The checks recover during the correction turn and the agent attempts publication", World.claude_checks_recover)
    .then("Publication and completion succeed without another correction", World.claude_recovery_releases_gate),

    Scenario("A recovered Claude failure can request correction again", "Claude recovery and changed findings", ("claude", "completion", "failure-cycle"))
    .given("A previously passing Claude watcher now reports warnings", World.claude_new_failure)
    .when("The failure is corrected and the same warnings return after another change", World.claude_repeat_failure_cycle)
    .then("The returning failure gets one fresh correction and empty retries remain guarded", World.claude_repeat_failure_is_fresh),

    Scenario("An interrupted Claude turn settles without a correction", "Claude interruption", ("claude", "completion", "interruption"))
    .given("A previously passing Claude watcher now reports warnings", World.claude_new_failure)
    .when("The agent turn is interrupted", World.claude_abort)
    .then("The turn settles without submitting a correction prompt", World.claude_abort_settles),

    Scenario("An interrupted Claude correction stays stopped", "Claude interruption", ("claude", "completion", "interruption", "retry-loop"))
    .given("A previously passing Claude watcher now reports warnings", World.claude_new_failure)
    .when("The correction turn is interrupted and the watcher repeats the same failure", World.claude_abort_correction)
    .then("The interrupted turn settles without submitting another correction", World.claude_interrupted_correction_stays_stopped),

    Scenario("Claude API-error completion does not queue a correction", "Claude interruption", ("claude", "completion", "api-error", "rate-limit"))
    .given("A previously passing Claude watcher now reports warnings", World.claude_new_failure)
    .when("Claude completes with the runtime's API-error event and the watcher repeats its failure", World.claude_api_error)
    .then("The unsuccessful turn settles without requesting another correction", World.claude_api_error_settles),

    Scenario("A user turn restores Claude reporting after interruption", "Claude interruption", ("claude", "completion", "user-resume"))
    .given("A previously passing Claude watcher now reports warnings", World.claude_new_failure)
    .when("The turn is interrupted and the user starts a new investigation turn", World.claude_resume_after_interruption)
    .then("Inspection succeeds and the remaining failure requests a fresh correction", World.claude_user_resume_reports_again),

    Scenario("Claude gates follow each watcher's recovery", "Claude multiple watchers", ("claude", "completion", "check-scope", "recovery"))
    .given("Claude has failing Zig and Zanity watchers and publication requires only Zanity", World.claude_two_watchers)
    .when("Zanity recovers before Zig and the agent attempts publication and completion", World.claude_mixed_recovery)
    .then("Publication follows Zanity while completion waits for both watchers to recover", World.claude_mixed_gates_follow_reports),

    Scenario("A restarted Claude session resets correction suppression", "Claude session lifecycle", ("claude", "session", "restart"))
    .given("A previously passing Claude watcher now reports warnings", World.claude_new_failure)
    .when("A correction is interrupted and the session is ended and started again", World.claude_restart_session)
    .then("The new session reports its new failure and requests a fresh correction", World.claude_restarted_session_corrects),

    Scenario("A resumed Claude session resets correction suppression", "Claude session lifecycle", ("claude", "session", "resume"))
    .given("A previously passing Claude watcher now reports warnings", World.claude_new_failure)
    .when("A correction is interrupted and Claude resumes the session", World.claude_resume_session)
    .then("The resumed session reports its new failure and requests a fresh correction", World.claude_resumed_session_corrects),

    Scenario("Repair remains possible during failure", "Failure gates", ("repair", "warnings"))
    .given("A previously passing check now reports 29 warnings", World.new_warnings)
    .when("The agent lists, searches, reads, edits, and runs check commands", World.inspect_and_repair)
    .then("Every repair operation is allowed and the edited file can be read", World.repair_operations_allowed),

    Scenario("Protected actions stay protected on every attempt", "Failure gates", ("protected-actions",))
    .given("A previously passing check now reports 29 warnings", World.new_warnings)
    .when("The agent attempts configured publication actions twice", World.attempt_protected_actions)
    .then("Every attempt is denied with the failing check's summary", World.protected_actions_denied),

    Scenario("Completion stays guarded during a continuation", "Failure gates", ("completion",))
    .given("A previously passing check now reports 29 warnings", World.new_warnings)
    .when("The agent repeatedly tries to finish, including a Stop continuation", World.attempt_completion)
    .then("Every completion attempt remains guarded", World.completion_denied),

    Scenario("Successful checks release the failure gate", "Failure gates", ("recovery",))
    .given("A previously passing check now reports 29 warnings", World.new_warnings)
    .when("The repaired code passes its check", World.report_success)
    .then("Completion and configured publication actions are allowed", World.gates_cleared),

    Scenario("Inherited debt does not absorb new failures", "Legacy debt", ("baseline", "regressions"))
    .given("The session starts with 29 inherited warnings under the default policy", World.inherited_warnings)
    .when("The agent attempts completion and publication", World.attempt_completion_and_publication)
    .then("Completion and configured publication actions are allowed", World.inherited_findings_allowed)
    .when("A change increases the warning count to 30", World.warnings_increase)
    .then("The new failure guards completion", World.new_findings_guarded),

    Scenario("A commit made with a failing edit does not hide the failure", "Legacy debt", ("baseline", "regressions", "commits"))
    .given("The project's files are committed and the session starts with a passing check", World.committed_clean_session)
    .when("One shell step breaks the check and commits the change", World.break_and_commit_in_one_step)
    .then("The failure is reported as new and Stop is refused", World.commit_does_not_hide_failure),

    Scenario("Strict inherited-finding policy still permits inspection", "Legacy debt", ("baseline", "strict"))
    .given("Inherited findings are configured to block", World.strict_inherited_policy)
    .and_("The session starts with 29 inherited warnings", World.inherited_warnings)
    .when("The agent attempts completion, publication, and inspection", World.attempt_completion_and_publication)
    .then("Completion and publication are denied while inspection remains available", World.inherited_findings_guarded),

    Scenario("Protected actions consult their relevant checks", "Failure gates", ("check-scope",))
    .given("Publication requires the passing Go check", World.passing_go_required)
    .and_("The unrelated Zanity check develops 29 warnings", World.new_warnings)
    .when("The agent attempts publication and completion", World.attempt_completion_and_publication)
    .then("Publication is allowed while overall completion remains guarded", World.publication_allowed_completion_guarded),

    Scenario("Inspection never starts a check", "Failure gates", ("repair", "check-execution"))
    .given("A previously passing check now reports 29 warnings", World.new_warnings)
    .and_("The checker is unavailable for a new run", World.checker_cannot_run)
    .when("The agent lists files", World.list_files)
    .then("Listing succeeds without rerunning or replacing the failed result", World.inspection_did_not_run_checks),

    Scenario("Editing a function activates its inherited findings", "Changed-code cleanup", ("changed-code",), status="proposed")
    .given("A function has three inherited warnings and another function has twelve")
    .when("The agent changes the first function")
    .then("Its three warnings require cleanup while the other twelve remain backlog")
    .and_("Repair tools remain available while completion is guarded"),

    Scenario("Moving a finding preserves its identity and age", "Finding age", ("identity", "age"), status="proposed")
    .given("An inherited finding has a recorded identity and first-seen date")
    .when("Unrelated lines are inserted above it or the agent session restarts")
    .then("Its identity and age remain unchanged and movement alone does not activate it"),

    Scenario("Changed code activates the cross-file findings it participates in", "Changed-code cleanup", ("changed-code", "cross-file"), status="proposed")
    .given("An inherited finding involves functions in two files")
    .when("The agent changes one of those participating functions")
    .then("That cross-file finding requires cleanup while unrelated findings remain backlog"),

    Scenario("Untouched debt escalates at its configured deadline", "Finding age", ("age", "deadlines"), status="proposed")
    .given("An inherited finding has a project-configured deadline")
    .when("A check runs after that deadline")
    .then("The finding escalates according to project policy without resetting its first-seen date"),

    Scenario("Disabling a rule is not a resolution", "Changed-code cleanup", ("rules", "resolution"), status="proposed")
    .given("A finding requires cleanup in changed code")
    .when("Its rule is disabled or its source path is excluded")
    .then("The finding is not recorded as fixed"),

    Scenario("TCR mode commits an edit that keeps the checks green", "Modes and limits", ("modes", "tcr", "checkpoint"))
    .given("The project runs overwatch in TCR mode with green checks", World.tcr_project)
    .when("The agent makes an edit and the checks on that edit pass", World.edit_keeping_checks_green)
    .then("The change is committed as a checkpoint", World.change_is_committed_as_a_checkpoint),

    Scenario("TCR mode reverts an edit that introduces a new failure", "Modes and limits", ("modes", "tcr", "revert"))
    .given("The project runs overwatch in TCR mode with green checks", World.tcr_project)
    .when("The agent makes an edit and the checks on that edit report a new failure", World.edit_adding_warnings)
    .then("The working tree is restored to the latest checkpoint and the agent is told which failure caused the revert", World.edit_is_reverted_and_told),

    Scenario("TCR mode leaves inherited failures alone", "Modes and limits", ("modes", "tcr", "inherited"))
    .given("The project runs overwatch in TCR mode and the session baseline has inherited failures", World.tcr_inherited_project)
    .when("The checks on an edit report only those inherited failures", World.edit_keeping_checks_green)
    .then("The change is committed as a checkpoint", World.change_is_committed_as_a_checkpoint),

    Scenario("TCR mode never acts on an overtaken result", "Modes and limits", ("modes", "tcr", "overtaken"))
    .given("The project runs overwatch in TCR mode with green checks", World.tcr_project)
    .when("The agent edits again while the checks on an earlier edit are running", World.edit_while_checks_run)
    .then("The earlier result neither commits nor reverts", World.edit_is_neither_committed_nor_reverted),

    Scenario("TCR mode does not start on a dirty working tree", "Modes and limits", ("modes", "tcr", "dirty-tree"))
    .given("The project runs overwatch in TCR mode and the working tree has uncommitted changes when the session starts", World.tcr_dirty_project)
    .when("The agent makes an edit that adds a failure", World.edit_adding_warnings)
    .then("Overwatch reports that TCR is unavailable and no revert discards those changes", World.tcr_is_reported_unavailable),

    Scenario("TCR mode pauses when a checkpoint commit fails", "Modes and limits", ("modes", "tcr", "commit-failure"))
    .given("The project runs overwatch in TCR mode with green checks", World.tcr_project)
    .and_("A commit hook refuses commits", World.a_commit_hook_refuses)
    .when("The agent makes an edit that keeps the checks green", World.edit_keeping_checks_green)
    .then("Overwatch reports that TCR is unavailable and the change stays staged", World.commit_failure_pauses_tcr),

    Scenario("Claude Code commits an edit that keeps the checks green", "Modes and limits", ("modes", "tcr", "checkpoint", "claude"))
    .given("The project runs overwatch in TCR mode in Claude Code with green checks", World.claude_tcr_project)
    .when("The agent makes an edit and the checks on that edit pass", World.claude_tcr_edit_keeping_checks_green)
    .then("The change is committed as a checkpoint", World.claude_tcr_commits),

    Scenario("Claude Code reverts an edit that introduces a new failure", "Modes and limits", ("modes", "tcr", "revert", "claude"))
    .given("The project runs overwatch in TCR mode in Claude Code with green checks", World.claude_tcr_project)
    .when("The agent makes an edit and the checks on that edit report a new failure", World.claude_tcr_edit_adding_warnings)
    .then("The working tree is restored to the latest checkpoint and the agent is told which failure caused the revert", World.claude_tcr_reverts_and_tells),

    Scenario("Claude Code leaves inherited failures alone in TCR mode", "Modes and limits", ("modes", "tcr", "inherited", "claude"))
    .given("The project runs overwatch in TCR mode in Claude Code and the session baseline has inherited failures", World.claude_tcr_inherited_project)
    .when("The checks on an edit report only those inherited failures", World.claude_tcr_edit_keeping_checks_green)
    .then("The change is committed as a checkpoint", World.claude_tcr_commits),

    Scenario("Claude Code never acts on an overtaken result in TCR mode", "Modes and limits", ("modes", "tcr", "overtaken", "claude"))
    .given("The project runs overwatch in TCR mode in Claude Code with green checks", World.claude_tcr_project)
    .when("The files change again before the checks on an earlier edit report", World.claude_tcr_files_change_again)
    .then("The earlier result neither commits nor reverts", World.claude_tcr_neither_commits_nor_reverts),

    Scenario("Claude Code does not start TCR on a dirty working tree", "Modes and limits", ("modes", "tcr", "dirty-tree", "claude"))
    .given("The project runs overwatch in TCR mode in Claude Code and the working tree has uncommitted changes when the session starts", World.claude_tcr_dirty_project)
    .when("The agent makes an edit that adds a failure", World.claude_tcr_edit_adding_warnings)
    .then("Overwatch reports that TCR is unavailable and no revert discards those changes", World.claude_tcr_is_unavailable),

    Scenario("Claude Code pauses TCR when a checkpoint commit fails", "Modes and limits", ("modes", "tcr", "commit-failure", "claude"))
    .given("The project runs overwatch in TCR mode in Claude Code with green checks", World.claude_tcr_project)
    .and_("A commit hook refuses commits", World.claude_tcr_commit_refused)
    .when("The agent makes an edit that keeps the checks green", World.claude_tcr_edit_keeping_checks_green)
    .then("Overwatch reports that TCR is unavailable and the change is not committed", World.claude_tcr_pauses),

    Scenario("Advisory mode reports failures without guarding", "Modes and limits", ("modes", "advisory"), status="proposed")
    .given("The project runs overwatch in advisory mode")
    .and_("A change introduces a new failure")
    .when("The agent tries to finish")
    .then("Completion is allowed")
    .and_("The agent is told of the new failure"),

    Scenario("Strict mode waits for a result of the latest edit", "Modes and limits", ("modes", "strict"), status="proposed")
    .given("The project runs overwatch in strict mode")
    .when("The agent edits and tries to finish before the checks have run on that edit")
    .then("Completion is guarded until a result of the latest edit passes"),

    Scenario("Edits wait while the agent is too far ahead of its checks", "Modes and limits", ("limits", "max-ahead"), status="proposed")
    .given("The project allows the agent three edits ahead of its latest result")
    .and_("Checks are still running on an earlier edit")
    .when("The agent attempts a fourth edit")
    .then("The edit waits for a result")
    .and_("Reading and running checks remain available"),

    Scenario("Strict mode hands a lingering failure to a person", "Modes and limits", ("limits", "red-budget"), status="proposed")
    .given("The project runs overwatch in strict mode with a budget of edits while red")
    .and_("A new failure has been reported")
    .when("The agent spends its budget without clearing the failure")
    .then("The turn stops and waits for a person instead of continuing"),

    Scenario("A check that exceeds its time limit fails", "Modes and limits", ("limits", "timeout"), status="proposed")
    .given("The project sets a time limit on checks")
    .when("A run exceeds it")
    .then("The run is stopped and reported to the agent as a timeout")
    .and_("A timeout is never recorded as inherited backlog"),
)
