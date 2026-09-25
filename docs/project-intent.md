# Project intent

## Accepted direction

Chandler Factory is a planned Rust factory/combat game. Its premise is a Factorio-like
industrial war against one enormous, continuous hive. The player begins in a small
foothold, manufactures supplies, and expands through regenerating biomass. Artillery
trains are central, supported by autonomous drones and defenses. Enemies are numerous,
individually weak, and endless. Sustained industrial support is necessary to hold
territory.

The engineering priority is an extremely efficient simulation capable of huge maps
and complex, heavily active factories. Early work may be entirely headless. Careful
research, explicit decisions, and strong evidence matter more than reaching a playable
prototype quickly.

## Not yet decided

Engine architecture, libraries, hardware targets, performance budgets, and simulation
rules remain open. Grids, rail graphs, fixed ticks, data layouts, and parallelism were
earlier suggestions, not accepted decisions. Rust is the intended implementation
language; that does not select an engine or runtime architecture.

## Foundation scope

Establish project management, durable documentation, scoped agent assignments, and
meaningful workflow verification. Initial tracked work concerns that foundation.
Engine requirements and research follow it; engine architecture and implementation
follow those investigations.

Chandler previously evaluated ChandlerStack and found no useful benefit over a capable
reasoning model for this purpose. This repository does not rebuild that orchestration
framework. Introduce lightweight checks only where they address an observed need or
an agreed boundary.
