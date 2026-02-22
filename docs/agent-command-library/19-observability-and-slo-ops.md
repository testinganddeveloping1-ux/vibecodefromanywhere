# Observability and SLO Operations

Improve debug speed and reliability by enforcing observable systems.

## Source Skills

- `distributed-tracing`
- `prometheus-configuration`
- `grafana-dashboards`
- `slo-implementation`

## Command Links

- `observability-pass`
- `perf-budget-gate`
- `incident-drill`

## Minimum Observability Contract

Every critical path includes:

- structured logs with correlation IDs
- traces through major service boundaries
- metrics for latency, errors, throughput
- dashboard panel for top failure classes
- alert tied to SLO burn or threshold breach

## SLO Definition Template

```text
SERVICE:
SLI:
SLO_TARGET:
MEASUREMENT_WINDOW:
ERROR_BUDGET:
ALERT_POLICY:
```

## Instrumentation Checklist

- [ ] request IDs present end-to-end
- [ ] error classes typed and counted
- [ ] retry/timeout metrics available
- [ ] queue lag and worker health metrics captured
- [ ] cleanup/finalization events captured

## Dashboard Requirements

- high-level service health summary
- top failing operations
- latency percentile panels (P50/P95/P99)
- saturation/resource panels
- deployment/change overlay markers

## Alerting Rules

- actionable alerts only
- route by ownership
- include runbook links
- avoid duplicate alert storms

## Anti-Patterns

- logs without correlation IDs
- metrics that cannot trigger decisions
- trace sampling too low to diagnose incidents

## Done Criteria

- observability contract implemented
- SLO and alert policies defined
- dashboards provide triage-ready signals
