# Model Lab Operating Contract

- Training success registers a model as `candidate`, never directly as `production`.
- The default training set contains production-candidate model families only.
- Transformer is experimental and must be selected explicitly.
- `/admin/experiments` is the controlled research surface.
- TensorFlow.js is an optional future edge inference runtime, not a model family.
- Promotion is explicit and requires evaluation, lineage, leakage validation, and operational readiness evidence.
