"""Behavior descriptions bind each implemented step to the real hook acceptance fixture."""
from .dsl import Scenario
from .world import AcceptanceWorld as World


SCENARIOS = (
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
)
