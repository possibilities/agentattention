# Glossary

- **Attention item**: A durable request for human attention, from creation to
  one terminal outcome. Its contract, payload, and resolution are opaque to
  this service. _Avoid_: request (ambiguous with an HTTP request), task (the
  service does not execute work), queue entry (ordering is a consumer policy).
- **Contract**: A namespaced identifier whose meaning producers and handlers
  negotiate outside this service. It describes both the opaque payload and
  the expected opaque resolution. _Avoid_: schema (the service does not store,
  fetch, or validate schemas), type (ambiguous with JSON and event types).
- **Claim**: A renewable, exclusive lease held by one authenticated principal
  while it handles an open attention item. _Avoid_: lock (claims expire),
  assignment (the service does not choose handlers).
- **Resolution**: The opaque JSON value returned when a handler completes an
  attention item. _Avoid_: response (ambiguous with an HTTP response), result
  schema (validation belongs to the negotiated contract).
- **Principal**: The identity attached to a bearer credential and recorded on
  mutations. _Avoid_: user (a principal may be an agent or tool), token (the
  secret authenticates the principal but is not its identity).
- **Event cursor**: The monotonically increasing sequence number of a durable
  event. Consumers persist it to resume an at-least-once event feed. _Avoid_:
  offset (events are not positionally paginated), timestamp cursor (timestamps
  are not unique).
