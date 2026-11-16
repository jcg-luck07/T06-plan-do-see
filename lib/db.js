// DB 연결. DATABASE_URL이 있으면 진짜 서버 DB(Supabase 등)에, 없으면 내 컴퓨터 안의 시험용 DB(.localdb)에 연결합니다.
const schema = require('./schema');

let ready = null;

async function connect() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const postgres = (await import('postgres')).default;
    const sql = postgres(url, { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 15 });
    return {
      kind: 'postgres',
      query: (text, params = []) => sql.unsafe(text, params),
      exec: (text) => sql.unsafe(text),
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = process.env.LOCAL_DB_DIR || '.localdb';
  const db = new PGlite(dir);
  return {
    kind: 'pglite',
    query: async (text, params = []) => (await db.query(text, params)).rows,
    exec: (text) => db.exec(text),
  };
}

function getDb() {
  if (!ready) {
    ready = (async () => {
      const db = await connect();
      try {
        await db.exec(schema);
      } catch (e) {
        // 서버가 동시에 처음 켜질 때 표 만들기가 겹치면 한 번 더 시도
        await new Promise((r) => setTimeout(r, 300));
        await db.exec(schema);
      }
      return db;
    })();
    ready.catch(() => { ready = null; });
  }
  return ready;
}

module.exports = { getDb };
