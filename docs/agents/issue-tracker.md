# Issue and Backlog Tracking

Lakomics uses two different tracking surfaces for different purposes.

## Living product backlog

`docs/roadmap/lakomics-backlog.md` is the default place for ongoing product bugs, UX improvements, architecture follow-ups, and long-term ideas that Laku wants retained with the repository.

Use it when:

- a bug or usability problem should be remembered for later work;
- a feature idea belongs on the Lakomics roadmap;
- priority or status needs to be adjusted across multiple future tasks;
- the user explicitly asks to record an item in the project document.

Do not create a second markdown backlog for the same work.

## GitHub Issues

Use GitHub Issues when the user explicitly asks for issue tracking or the task already lives in an Issue. An existing Issue may be read for context; creating, editing, commenting on, or closing it still requires that write to be within the authorized task. Perceived usefulness alone is not authorization.

Do not automatically mirror every roadmap item into an Issue. If an Issue is created from a roadmap item, link/reference the issue from the roadmap rather than maintaining two independent descriptions.

When GitHub integration is available, use it directly. If it is unavailable and `gh` CLI is available, the normal fallback is `gh issue view/list/create/edit/comment/close` as appropriate. Never guess Issue state when neither path is available.

Pull Requests are implementation/review surfaces, not a general product inbox.
