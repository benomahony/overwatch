# How Overwatch behaves

Generated from the executable scenarios in `tests/acceptance/catalog.py`.
Run `python3 scripts/scenarios.py` to verify the scenarios and regenerate this page.

## Verified behavior

### Failure gates

#### Repair remains possible during failure

Tags: repair, warnings.
[View test](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/catalog.py#L7)

- **Given** [A previously passing check now reports 29 warnings](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L67).
- **When** [The agent lists, searches, reads, edits, and runs check commands](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L72).
- **Then** [Every repair operation is allowed and the edited file can be read](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L87).

#### Protected actions stay protected on every attempt

Tags: protected-actions.
[View test](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/catalog.py#L12)

- **Given** [A previously passing check now reports 29 warnings](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L67).
- **When** [The agent attempts configured publication actions twice](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L93).
- **Then** [Every attempt is denied with the failing check's summary](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L98).

#### Completion stays guarded during a continuation

Tags: completion.
[View test](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/catalog.py#L17)

- **Given** [A previously passing check now reports 29 warnings](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L67).
- **When** [The agent repeatedly tries to finish, including a Stop continuation](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L104).
- **Then** [Every completion attempt remains guarded](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L107).

#### Successful checks release the failure gate

Tags: recovery.
[View test](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/catalog.py#L22)

- **Given** [A previously passing check now reports 29 warnings](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L67).
- **When** [The repaired code passes its check](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L110).
- **Then** [Completion and configured publication actions are allowed](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L114).

#### Protected actions consult their relevant checks

Tags: check-scope.
[View test](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/catalog.py#L40)

- **Given** [Publication requires the passing Go check](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L146).
- **And** [The unrelated Zanity check develops 29 warnings](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L67).
- **When** [The agent attempts publication and completion](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L130).
- **Then** [Publication is allowed while overall completion remains guarded](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L153).

#### Inspection never starts a check

Tags: repair, check-execution.
[View test](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/catalog.py#L46)

- **Given** [A previously passing check now reports 29 warnings](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L67).
- **And** [The checker is unavailable for a new run](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L157).
- **When** [The agent lists files](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L161).
- **Then** [Listing succeeds without rerunning or replacing the failed result](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L164).

### Legacy debt

#### Inherited debt does not absorb new failures

Tags: baseline, regressions.
[View test](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/catalog.py#L27)

- **Given** [The session starts with 29 inherited warnings under the default policy](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L118).
- **When** [The agent attempts completion and publication](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L130).
- **Then** [Completion and configured publication actions are allowed](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L135).
- **When** [A change increases the warning count to 30](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L139).
- **Then** [The new failure guards completion](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L143).

#### Strict inherited-finding policy still permits inspection

Tags: baseline, strict.
[View test](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/catalog.py#L34)

- **Given** [Inherited findings are configured to block](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L122).
- **And** [The session starts with 29 inherited warnings](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L118).
- **When** [The agent attempts completion, publication, and inspection](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L130).
- **Then** [Completion and publication are denied while inspection remains available](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/world.py#L125).

## Proposed behavior (not implemented)

### Changed-code cleanup

#### Editing a function activates its inherited findings

Tags: changed-code.
[View proposal](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/catalog.py#L52)

- **Given** A function has three inherited warnings and another function has twelve.
- **When** The agent changes the first function.
- **Then** Its three warnings require cleanup while the other twelve remain backlog.
- **And** Repair tools remain available while completion is guarded.

#### Changed code activates the cross-file findings it participates in

Tags: changed-code, cross-file.
[View proposal](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/catalog.py#L63)

- **Given** An inherited finding involves functions in two files.
- **When** The agent changes one of those participating functions.
- **Then** That cross-file finding requires cleanup while unrelated findings remain backlog.

#### Disabling a rule is not a resolution

Tags: rules, resolution.
[View proposal](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/catalog.py#L73)

- **Given** A finding requires cleanup in changed code.
- **When** Its rule is disabled or its source path is excluded.
- **Then** The finding is not recorded as fixed.

### Finding age

#### Moving a finding preserves its identity and age

Tags: identity, age.
[View proposal](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/catalog.py#L58)

- **Given** An inherited finding has a recorded identity and first-seen date.
- **When** Unrelated lines are inserted above it or the agent session restarts.
- **Then** Its identity and age remain unchanged and movement alone does not activate it.

#### Untouched debt escalates at its configured deadline

Tags: age, deadlines.
[View proposal](https://github.com/benomahony/overwatch/blob/main/tests/acceptance/catalog.py#L68)

- **Given** An inherited finding has a project-configured deadline.
- **When** A check runs after that deadline.
- **Then** The finding escalates according to project policy without resetting its first-seen date.
