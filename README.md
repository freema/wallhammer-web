# Wallhammer Web

Webový 3D engine, ve kterém celý svět vzniká z kódu: čisté WebGL2, žádná grafická knihovna, žádné načítané obrázky. Striktní TypeScript, moduly ve vrstvách, deterministická simulace, streamovaný svět od jednoho domu po sluneční soustavu.

Repozitář je pracovní prostor pnpm:

- `packages/wallhammer-web/`: engine, npm balíček `wallhammer-web`. Popis je v jeho [`README.md`](packages/wallhammer-web/README.md), dokumentace v [`docs/`](packages/wallhammer-web/docs/) (anglicky, ukázky kódu se typově kontrolují).
- `tools/`: kontroly enginu (`layers`, `golden/engine`, `docs`, `pack`).
- `examples/`: příklady nad enginem. Zatím tu nejsou, viz [Co zbývá přenést](#co-zbývá-přenést).
- `.claude/skills/` a `CLAUDE.md`: pravidla a postupy pro práci s agentem (spuštění, kontroly, rozšiřování).

## Spuštění

Všechno běží v Dockeru. Na počítači stačí Docker s `docker compose` a git, Node potřeba není.

```sh
docker compose up -d     # z kořene repozitáře
docker compose ps        # dev má být (healthy)
```

Služba `dev` nainstaluje závislosti a zůstane běžet pro kontroly. Nezveřejňuje žádný port. Závislosti žijí v pojmenovaných svazcích, na disk se nic neinstaluje. Zastavení: `docker compose down`.

## Kontroly

```sh
docker compose exec -T dev sh -c 'cd /app && pnpm typecheck'          # typy; bez chyby
docker compose exec -T dev sh -c 'cd /app && pnpm check:layers'       # layers: 0 violation(s)
docker compose exec -T dev sh -c 'cd /app && pnpm check:layers:test'  # ok: known-bad fixture fails with all 16 expected findings
docker compose exec -T dev sh -c 'cd /app && pnpm test:golden'        # golden: 72 of 72 generators unchanged
docker compose exec -T dev sh -c 'cd /app && pnpm check:docs'         # docs: … 0 finding(s)
docker compose exec -T dev sh -c 'cd /app && pnpm check:pack'         # ok: the packed package installs, loads and type-checks
```

- `check:layers` hlídá vrstvy modulů, hranici mezi enginem, obsahovými moduly a příklady a to, že WebGL je jen v `gpu` a DOM jen v `platform`. Výjimky nejsou.
- `test:golden` spustí generátory a deterministické systémy enginu s pevným vstupem a porovná otisk výstupu s `tools/golden/engine/hashes.json`. Záměrnou změnu přijmeš `node tools/golden/engine/golden.ts --accept` v kontejneru; přepíše všechny otisky najednou, proto nejdřív přečti, co se změnilo. Pravidla: [`docs/tools.md`](packages/wallhammer-web/docs/tools.md).
- `check:docs` typově zkontroluje ukázky v dokumentaci a ověří odkazy.
- `check:pack` zkontroluje balíček ve tvaru, v jakém půjde na npm (viz níže). Potřebuje síť.

## Balíček npm

V pracovním prostoru balíček vyváží zdrojové soubory TypeScriptu (`exports` → `src/`), takže příklady vidí změnu enginu hned. Zveřejněný balíček obsahuje sestavený JavaScript s deklaracemi typů (`dist/`), dokumentaci, `README.md` a `LICENSE`. O sestavení se stará `prepack` (`tsc -p tsconfig.build.json`) a o záměnu vstupů `publishConfig.exports` v [`package.json`](packages/wallhammer-web/package.json).

Zveřejnění dělá člověk s účtem na npm. Přihlášení i zveřejnění se pouští v kontejneru, na hostiteli Node není:

```sh
docker compose exec -T dev sh -c 'cd /app && pnpm check:pack'                          # nejdřív kontrola
docker compose exec dev sh -c 'cd /app/packages/wallhammer-web && npm login'           # jednou; přihlášení zůstane jen v kontejneru
docker compose exec dev sh -c 'cd /app/packages/wallhammer-web && pnpm publish --no-git-checks'
```

- Zveřejňuj přes `pnpm publish`, ne `npm publish`: jen pnpm použije `publishConfig.exports`. Balíček z `npm publish` by mířil na `src/`, které v něm není.
- Verzi nastav předem v `packages/wallhammer-web/package.json` (teď `0.4.0`). Jednou zveřejněnou verzi nejde na npm přepsat.
- `--no-git-checks`: v kontejneru není git, pnpm tam stav větve nezkontroluje. Že je pracovní strom čistý a na `main`, ověř předem na hostiteli (`git status`).
- Nový vstup `wallhammer-web/<modul>` se zapisuje dvakrát: do `exports` i do `publishConfig.exports`. `check:pack` na chybějící dvojici přijde.

## Odkud to je

Engine vznikl v repozitáři modelu města Ústí ve složce `web/packages/wallhammer-web`. Tento repozitář je jeho tvrdá kopie ze stavu commitu `aba73fe` (verze 0.4.0, včetně chůze světem) a od teď jediné místo, kde se engine vyvíjí. V repozitáři města zůstává zmrazená kopie téže verze pro tamní aplikaci; novější verzi si odtud převezme, až ji bude potřebovat.

Věrnost kopie hlídají zlaté otisky: 72 receptů enginu dává zde stejné otisky jako v původním repozitáři. Čtyři recepty tam závisely na kódu aplikace (postavy, vozidla, zastávky, významné stavby), ty zůstaly u aplikace.

## Co zbývá přenést

Příklady enginu a jejich nástroje se vyvíjely ve vedlejší složce, která engine jen připojovala z repozitáře města. Do tohoto repozitáře patří:

| Co | Kam | Poznámka |
| --- | --- | --- |
| `examples/*` (`minimal-3d`, `destruction`, `endless`, `planet`, `system`, `fantasy-village`, `walk` a další) | `examples/` | `pnpm-workspace.yaml` s nimi už počítá |
| `tools/golden/{golden.ts,hashes.json,*-scenario.ts}` | `tools/golden/` | recepty, které potřebují kód příkladů; recepty enginu jsou v `tools/golden/engine/`, soubory se nepřekrývají |
| `tools/walk/`, `tools/follow-check/` | stejné cesty | kontroly chůze a sledovací kamery (`check:walk`, `check:follow`) |
| `tools/vite/`, `tools/shot/`, `tools/bench/` | stejné cesty | doplněk vývojového serveru a nástroje na hostiteli |
| služby příkladů z `docker-compose.yml`, složky v `Dockerfile.dev` | sem | jedna služba, jeden svazek `node_modules` a jeden řádek `mkdir` na příklad |

Co při přenosu změnit:

1. **Engine už se nepřipojuje.** Ze všech služeb pryč s řádkem `- ../usti/web/packages/wallhammer-web:/app/packages/wallhammer-web` a u `dev` i s připojením `../usti/web/tools/docs`. Engine i kontrola dokumentace jsou v tomto repozitáři. Z `.gitignore` příkladů nepřebírej řádky `packages/wallhammer-web/` a `tools/docs/` (tam to byly přípojné body).
2. **`tools/layers/` nepřepisovat naslepo.** Zdejší kontrola vrstev je kopie té z příkladů (zná `examples/*` i pravidlo `example-imports`). Když je tamní novější (seznam `ENGINE_ONLY_EXAMPLES`), převezmi ji celou.
3. **`package.json` v kořeni:** `test:golden` má pustit obě sady (`node tools/golden/engine/golden.ts && node tools/golden/golden.ts`), přidat `check:walk` a `check:follow`. Jméno projektu v `docker-compose.yml` je tu `wallhammer-web`, obraz `wallhammer-web-engine:dev`.
4. **Služba `shot`** se stavěla z nástroje vizuální kontroly v repozitáři města (`../usti/web/tools/visual`, obraz `usti-visual:1`). Sem je potřeba přenést její `Dockerfile`, nebo ji stavět z vlastního.
5. **Texty.** README, dovednosti a komentáře příkladů mluví o „repozitáři Ústí“ a „složce Wallhammer“. Zdejší dovednosti (`.claude/skills/`) už jsou přepsané na tento repozitář; po přenosu doplň tabulku služeb ve `wallhammer-run` a počet otisků ve `wallhammer-verify`.
6. **Lock.** Po přidání příkladů obnov `pnpm-lock.yaml`: `docker compose exec -T dev sh -c 'cd /app && pnpm install --no-frozen-lockfile --store-dir /pnpm-store'`.

Dokumentace enginu už o příkladech mluví jako o `examples/<jméno>` v tomto repozitáři.

## Kopie v repozitáři města

Repozitář modelu města Ústí má ve `web/packages/wallhammer-web` tvrdou kopii verze 0.4.0 a smí si ji pro své potřeby upravit. Aby se obě kopie nerozešly naslepo, platí tam pravidlo: každá změna té kopie se zároveň pošle sem jako issue nebo pull request (co se změnilo, proč, odkaz na commit). Tady se rozhodne, jestli ji engine převezme, a odpověď se zapíše do téhož issue. Opačným směrem se novější engine do repozitáře města přebírá jen vědomě, jedním pull requestem s tamními kontrolami.

## Licence

MIT, plný text v [`LICENSE`](LICENSE). Stejný soubor je i v balíčku (`packages/wallhammer-web/LICENSE`).
