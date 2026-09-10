# Naming — how `portograph` was chosen

Three vetting rounds, 2026-09-09/10. Method per name: `npm view`, PyPI JSON API, crates.io API,
GitHub search (authenticated) for exact-name repos and users/orgs, `dig` for `.dev`/`.io`/`.com`,
page titles of resolving domains, WIPO Global Brand Database (real browser session in round 1;
CAPTCHA-walled in rounds 2–3), web search on trademark aggregators (Justia, Trademarkia,
uspto.report) and for live products/companies, plus a Russian-language collision search and a
transliteration check.

**Standing caveat:** "none found" means not found in those sources. EUIPO, TMview, USPTO direct
search and Rospatent were all unreachable to agents. A direct lookup is required before filing.

## Round 1 — English coinages

| Name | npm | PyPI | crates | GitHub | WIPO | Collisions | RU |
|---|---|---|---|---|---|---|---|
| portlay | free | free | free | 0 exact | 0 | **live SaaS portlay.app** (agency CMS) | ok |
| tierlay | free | free | free | 0 | 0 | none | reads as "тир-лей?" — rejected on pronunciation |
| patchlay | free | free | free | 0 | 0 | phonetic neighbour "Patchly" ×3 | ok |
| loomlay | free | free | free | 0 | 0 | GitHub user + .com taken; Loomerly/Loomble marks | ok |
| rungly | free | free | free | 1 (0★) | 0 | social handles only | ok |
| ortholay | free | free | free | 0 | 0 | Brazilian dental shop trade name | ok |
| wirelay | free | free | free | 4 | 2 expired (rope) | Samtec "Wirelay" | ok |
| schemly | free | free | free | 3 | 0 | **schemly.dev live dev tool** | ok |
| plumbly / portique / wirly / bluelay / riserly / pinlay | various | | | | | live products, marks, or PinLayout 2.4k★ | bluelay bad in RU |

## Round 2 — Russian words and Latin coinages (constraint: pronounceable in Russian)

| Name | Registries | GitHub | Collisions | Verdict |
|---|---|---|---|---|
| yarus (ярус) | free | none ≥50★ | **ЯRUS social network; ООО «Ярус»; yarus.pro** | out |
| rasklad (расклад) | free | none | none in IT; tarot connotation; EN mangles | fallback only |
| portik (портик) | free | 19★ port CLI | **Portik App MX, Portik Chantiers** | out |
| stroy, trassa, shina | free | none | Навис «Трасса», TRASSIR; "destroy" echo; generic "bus" | out |
| uklad, sloy, setka, plast, strato, nodara | **taken** on npm or PyPI | | | out |
| portolo | free | none | portolo.com login-gated unknown; Pòrtolo (IT produce) | weak |
| portino | free | none | Portino Digital Solutions (DE); tile brand | weak |
| **portula** | free | none | **none** (village; NL builder) | **fallback** |
| livello | free | none | **Livello Technologies GmbH** (IoT + SaaS) | out |
| ordito | free | 5★ | **four live SaaS products** | out |
| tramo, trazo, plano, nexo, lamina, rango, tabula, linora | taken somewhere, or 1k–7k★ repos | | | out |

User constraint refined mid-round: European/Latin roots preferred over Russian words.

## Round 3 — on request

| Name | Registries | GitHub | Domains | Collisions | Trademark |
|---|---|---|---|---|---|
| portgraph | npm free; **PyPI + crates taken** | Quantinuum/portgraph 17★, v0.16.2 (2026-09-07), 525k downloads | .com empty; .dev/.io none | "port graph" is a generic CS term (PORGY, KCL); active same-concept crate | merely descriptive — expect refusal |
| **portograph** | **all free** | no exact repo, no user; only "portography" photo pages | .dev/.io none; .com held idle since 2019 (GoDaddy, renewed 2026-04) | **no software**; Portograph Studio (ID type foundry — fonts are Class 9); Portograf Ltda (BR print shop); *portografía* = medical term ES/PT/IT | coined → distinctive; passes descriptiveness |

## Decision

**portograph.** Reads the same in both alphabets (Портограф, on the картограф pattern), says
port + graph, is clean where it matters, and is coined enough to own. Pronounce POR-to-graf.
Fallback: portula. Recorded in ADR-0007.
