# Testing log

| Date | Phase | Deal IDs | Result | Fixes |
|---|---|---|---|---|
| 2026-09-23 | 0 | none (read-only group-by of `electricity__retailer`, pipeline 978394588) | Normaliser maps all 40 distinct raw values; totals match spec §4.1 (Origin 97, AGL 72, EA 69, Red 65, 28 invalid, 218 blank). Only 1 deal currently in stage `1879662022`. | Added `neca` and NMI-in-retailer-field (`41024797705`) as invalid; both were missing from the spec's list. |
