# 0001: Routing overrides as `find` flags

Status: accepted

## Context

Harness hooks are one shell command. Users want different limits or timeouts per harness without separate config files.

## Decision

`otherskill find` accepts `--max-skills`, `--max-categories`, `--timeout-ms`, `--categories`, `--model`, `--config` and `--home`. They override config for that call only and are never written to config.

## Consequences

Hook commands are self-describing and per-harness tuning needs no extra files. Config stays the single source of defaults. Model overrides are one decision model id; paid ones need the opt-in (see [ADR 0009](0009-paid-decision-models.md)). The flag set is a public interface to keep stable.
