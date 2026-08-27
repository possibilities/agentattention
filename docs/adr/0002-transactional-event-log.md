# 0002: Persist events with state transitions

Every externally visible mutation appends its event in the same SQLite
transaction. Consumers therefore resume from one monotonic event cursor with
at-least-once delivery and never observe a committed state transition whose
event was lost.
