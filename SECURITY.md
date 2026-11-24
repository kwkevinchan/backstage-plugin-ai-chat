# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it
privately with GitHub's private vulnerability reporting:

1. Open the [Security tab](https://github.com/kwkevinchan/backstage-plugin-ai-chat/security)
   of the repository.
2. Choose **Report a vulnerability** and describe the problem, the affected
   packages and versions, and how to reproduce it.

The maintainer will reply as soon as possible. Once a fix is released, the advisory
is published with credit to the reporter, unless you prefer otherwise.

## Supported versions

Only the latest released version of each package gets security fixes. The
project supports one Backstage release line at a time (see the
[compatibility table](README.md#compatibility)).

## Scope

In scope: the published packages in `plugins/` (the backend and frontend
plugins). The development packages in `packages/` are examples and are not
published.

Examples of what is in scope: an action that is not read-only that runs
without the approval of the owner of the conversation; an approval that runs
anything but the input that the card showed; a decision that is accepted twice
or from another user; access to the conversation of another user; the API key
in a log, a response or the frontend configuration.

Before you report: the chat gives the model the tools that the actions service
lists for the user, and every action runs with the permissions of that user.
An action that the user may run, and that the user approves on the card, is
not a vulnerability of this plugin. Restrict what the chat can offer with
`aiChat.actions.include` and `exclude` and with `backend.actions.filter`.
Text that a model writes next to the card is not part of the call; the card is.

Problems in Backstage, in the model server or in other dependencies should be
reported to those projects. See the [security notes](README.md#security-notes)
in the README for how to run the plugin safely.
