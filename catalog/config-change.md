# Service config change

Starting risk: Low.

## Files touched

- `services/<product>/<service>/config.json`

## Complete request

A complete request contains:

- issue number
- change type `config-change`
- summary
- product
- service
- environment
- allowed paths, limited to `services/<product>/<service>/config.json`
- plan revision
- acceptance expectation

The request shape is `contracts/change-request.schema.json`.

## Shape

Copy the existing `config.json` for that service. The matter-search baseline is CPU 512, memory 1024, environment `dev`, account `111111111111`, and `publicEndpoint` false.

## CPU and memory

`npm run check:resources` accepts only these pairs. CPU is in units. Memory is in MiB.

- CPU 256 with memory 512, 1024, or 2048
- CPU 512 with memory 1024, 2048, 3072, or 4096
- CPU 1024 with memory 2048, 3072, 4096, 5120, 6144, 7168, or 8192
- CPU 2048 with memory 4096 through 16384 in steps of 1024
- CPU 4096 with memory 8192 through 30720 in steps of 1024

Any other combination is invalid and fails the check.

Preferred catalog maximum: CPU 1024 and memory 2048. A valid pair above that maximum is beyond catalog defaults. That is SIZE-01, effect medium. It is still a valid configuration. The schema check and the combination check are separate.

## Starting risk

Low, before SIZE-01 or another rule applies.
