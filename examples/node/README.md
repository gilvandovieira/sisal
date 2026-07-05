# Sisal on Node — examples

One minimal, runnable example per engine family, using the published
`@sisaljs/*` npm packages on **Node 24+**. See
[`docs/node.md`](../../docs/node.md) for the full guide.

| Example | Driver | Needs a database? |
| ------- | ------ | ----------------- |
| [`sqlite/`](sqlite/) | built-in `node:sqlite` | No — in-memory |
| [`pg/`](pg/) | `postgres` (postgres.js) | Yes — `DATABASE_URL` |
| [`mysql/`](mysql/) | `mysql2` | Yes — `MYSQL_URL` |

## Run

```sh
cd examples/node/sqlite
npm install
npm start
```

`pg` and `mysql` need a running database — the repo's `docker/compose.yaml`
provides both:

```sh
docker compose -f ../../../docker/compose.yaml up -d pg16 mysql

cd examples/node/pg
npm install
DATABASE_URL=postgres://postgres:postgres@localhost:55416/sisal npm start

cd ../mysql
npm install
MYSQL_URL=mysql://root:root@localhost:33306/sisal npm start
```

> These examples pin `@sisaljs/*@^0.12.0`. Before the packages are published,
> run them against a local build by linking `npm/<pkg>` with
> `npm install --install-links` (see `tools/npm_e2e/run.sh`).
