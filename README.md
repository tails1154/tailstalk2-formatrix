# tailstalk2-formatrix

A small Matrix Client-Server API adapter for TailsTalk 2.

The first version maps TailsTalk servers to Matrix Spaces and text channels to
Matrix rooms. It intentionally does not implement federation, end-to-end
encryption, media, reactions, calls, or Matrix application services.

The adapter keeps its Matrix access-token/session mapping in `DATA_DIR` and
uses the existing TailsTalk REST and events APIs for authentication, room
metadata, message sending, and live message delivery.

The public homeserver URL for this deployment is:

`https://tailstalk2.com/matrix`
