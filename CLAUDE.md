# Wallhammer Web

Webový 3D engine nad čistým WebGL2 (`packages/wallhammer-web`, npm balíček `wallhammer-web`), jeho kontroly (`tools/`) a příklady (`examples/`). Odpovídej česky.

## Pravidla

- **Jen Docker.** Vývoj i kontroly běží v kontejneru `dev` (`docker compose up -d`). Na hostiteli se neinstaluje Node ani balíčky.
- **Kontroly před „hotovo“.** Po každé změně pusť kontroly (dovednost `wallhammer-verify`) a uveď jejich výsledek. Co neprošlo nebo se nepouštělo, řekni.
- **Otisky se nepřijímají bez souhlasu.** `--accept` u zlatých otisků přepíše všechny otisky najednou. Nejdřív řekni, které recepty se změnily a proč, a počkej na souhlas.
- **Vrstvy.** Modul dováží jen nižší vrstvy. WebGL je jen v `gpu`, DOM jen v `platform`. Moduly mimo obsahové (`gen-arch`, `gen-ground`, `gen-vegetation`) nesmějí jmenovat případ užití. Výjimky nejsou, nález se opravuje přesunem kódu (`packages/wallhammer-web/docs/architecture.md`).
- **Žádná 3D ani grafická knihovna, žádné načítané obrázky.** Všechna grafika vzniká z kódu.
- **Determinismus.** Generátory jsou čisté funkce (vstup a semínko → data), náhoda jen z pojmenovaných proudů (`hashInts`), nikdy `Math.random` ani čas.
- **Komentáře v kódu anglicky**, dokumentace enginu anglicky, README repozitáře a zprávy commitů česky.
- **Nic projektového v enginu.** Data konkrétního místa, texty rozhraní a obsah jedné hry patří do projektu, který engine používá, nebo do příkladu.
- **Commit, push a zveřejnění na npm jen na výslovný pokyn.** Verzi balíčku mění uživatel.

## Kde co je

- `packages/wallhammer-web/src/<modul>/` moduly enginu, `packages/wallhammer-web/docs/` dokumentace (ukázky v ní se typově kontrolují).
- `tools/layers`, `tools/golden/engine`, `tools/docs`, `tools/pack`: kontroly enginu.
- `.claude/skills/`: `wallhammer-run` (spuštění), `wallhammer-verify` (kontroly), `wallhammer-extend` (kam co patří při rozšiřování).
- `README.md`: spuštění, kontroly, zveřejnění na npm a co zbývá přenést (příklady).
