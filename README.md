# TEN Business Playground

A business game for school students aged 13–17. You run a small shop for eight
weeks: set a price, buy stock, watch the week resolve. Nobody tells you that
cutting the price can raise sales and still lose money — you watch it happen.

Separate from the internship portal: different repo, different hosting, no
shared infrastructure.

    app/     the site, the API and the tutor   (Cloudflare, free tier)
    model/   training and local inference      (Colab / personal laptop)

**Running cost: ₹0.** Workers, D1 and Workers AI all sit inside free
allowances, and a `*.workers.dev` subdomain costs nothing.

Live at <https://ten-biz-game.tenetwork.workers.dev>

---

## Deploying

**Merging a pull request deploys it.** A GitHub Action runs the tests, creates
any new tables and pushes the Worker — about a minute, no laptop involved.
Watch it on the repository's Actions tab.

It needs one repository secret, `CLOUDFLARE_API_TOKEN`, holding a Cloudflare
API token with `Workers Scripts: Edit`, `D1: Edit` and `Workers AI: Edit` on
this account.

The Worker itself needs two settings, both in the Cloudflare dashboard under
Settings → Variables and Secrets, and both as **Secrets** rather than plain
variables so a deploy cannot wipe them:

    ADMIN_EMAILS     who may open /admin, comma-separated
    ADMIN_PASSWORD   a second passphrase that page also asks for

Both are needed. Either one missing means nobody reaches /admin, which is
deliberate — that page can reset any teacher's password, and neither secret
is in the database, so a stolen `teacher` table does not open it.

Everything below is the manual route, for when you want to deploy without
merging anything.

> **Never run `wrangler d1 create` again.** The database already exists and its
> id is committed in `app/wrangler.toml`. Running it a second time makes a
> SECOND, empty database and orphans the live one — with every class, every
> teacher account and every student's progress still inside it.

```bash
git clone https://github.com/the-Entrepreneurship-Network/ten-biz-game.git
cd ten-biz-game/app

npm install
npm test                 # 117 tests, no network, no database

npx wrangler login       # once per machine, opens a browser
npm run db:init          # only when schema.sql changed — safe to re-run
npm run deploy
```

`db:init` is every statement in `schema.sql`, and every one of them is
`CREATE TABLE IF NOT EXISTS`. There is no `ALTER`, so running it against the
live database adds what is missing and leaves the rest alone.

## Day to day

```bash
npm test                 # the whole suite
npm run dev              # local preview on localhost:8787
npm run deploy           # live in about ten seconds
```

---

## How it fits together

One Worker serves everything — the pages, the API and the tutor. No build
step: the HTML in `public/` is the HTML that ships.

| | |
|---|---|
| `src/sim.js` | one week of a shop: demand, stock, spoilage, rent |
| `src/game.js` | the eight-week run, the weather, the coins |
| `src/auth.js` | teacher passwords, class codes, sessions |
| `src/index.js` | every route, and the only file that touches the database |
| `public/` | three pages — the landing page, the game, the teacher view |
| `schema.sql` | the whole database |

The weather is derived from the run id, not rolled. A student who could
refresh away a bad week would refresh until the festival, and the lesson —
that demand is not yours to control — would go with it.

## What is built

- **The game.** Three businesses, eight weeks, pricing and stock decisions,
  a tutor that explains the week in plain words.
- **Classes.** A teacher creates one and reads out a six-character code.
  Students join with that code and a first name.
- **A teacher dashboard.** Who has not started, who priced below cost, who
  never moved their price. Exports as CSV.
- **A shop you grow.** Coins buy a signboard, a fridge or a bigger stall —
  and the bigger stall raises the rent as well as the demand.
- **A class table.** Top ten by best cash, and your own rank. There is no
  bottom of the table on purpose.

## What is deliberately missing

- **Student logins.** `sid` is an opaque cookie, not authentication — any
  caller can claim any id. That is fine while the only data is a first name
  and a points total, and it is why no student is ever asked for an email
  address. It must become a real session before anything personal is stored.
  (Teachers *do* have real sessions: PBKDF2 passwords, server-side tokens.)
- **Payments.** Schools are invoiced. No gateway, by decision.
- **A second shop per student.** Expansion is the obvious next feature and is
  not built.

## The numbers that need a real classroom

Two constants are guesses until a class has actually used this:

- `UPGRADES[*].cost` in `src/sim.js` — what an upgrade costs
- `coinsFor()` in `src/game.js` — what a week pays out

Coins carry between runs while upgrades do not, so a student on their third
shop can afford everything at once. Tune these together, with real data.
