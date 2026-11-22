# Corner Runner

A survival baseline for Builders Mech Royale. It follows reachable ground toward the next circle, retreats toward building cover on contact, and takes a laser when one is already within reach. Each scored run evaluates one fixed strategy.

The protocol wrapper in `mechfight.py` comes from the official Builders starter kit. The navigation and decision logic were developed for this entry. Runtime dependencies are Python's standard library and the organizer-provided map mounted at `/arena`.
