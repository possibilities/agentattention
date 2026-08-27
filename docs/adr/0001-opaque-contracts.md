# 0001: Contracts are opaque to the service

Attention items carry a namespaced contract identifier plus arbitrary JSON.
Producers and handlers negotiate and validate that contract outside the daemon,
keeping this service usable across approval, question, CAPTCHA, and live
handoff protocols without turning it into a schema registry.
