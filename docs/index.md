---
layout: home

hero:
  name: Dusklight
  text: Universal UI Client
  tagline: Pattern-driven rendering and capability-safe actions for arbitrary data
  actions:
    - theme: brand
      text: Philosophy
      link: /philosophy
    - theme: alt
      text: Architecture
      link: /architecture

features:
  - title: Pattern-First Rendering
    details: Data flows through recognition → rendering. Teach Dusklight patterns, it applies them everywhere. Multiple renderers may match; the user picks, preferences persist.
  - title: Marinada Expression Language
    details: Actions are pure JSON expressions — serializable, inspectable, replayable. The same language drives layout property bindings, renderer dispatch, and optics composition.
  - title: Capability-Based Security
    details: Plugins operate under the object-capability model. No ambient authority. A plugin that hasn't been granted a capability cannot exercise it — authority is visible in the program.
  - title: Everything is a Plugin
    details: Sources, parsers, patterns, renderers — all pluggable ES modules. Core orchestrates, plugins do the work. Distribution via npm, jsr, URL, or local path.
---
