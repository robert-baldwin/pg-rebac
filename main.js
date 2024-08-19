import pg from 'pg'
import yaml from 'js-yaml'
import fs from 'fs'
import readline from 'readline'

const { Pool } = pg

const db_config = readDatabaseConfig('config/db.yaml')
const usersets = readUsersetsConfig('config/usersets.yaml')
const pool = new Pool(db_config.db)
const graph = db_config.graph.name;

function readDatabaseConfig(filename) {
  return yaml.load(fs.readFileSync(filename, 'utf8'))
}

function readUsersetsConfig(filename) {
  const usersets = yaml.load(fs.readFileSync(filename, 'utf8'))
  return transformUsersets(usersets)
}

function transformUsersets(obj, prefix = '') {
  let result = {};
  for (const key in obj) {
    const newKey = prefix ? `\`${prefix}.${key}\`` : key;
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      Object.assign(result, transformUsersets(obj[key], newKey));
    } else {
      result[newKey] = typeof obj[key] === 'string' ? obj[key].split('|').map(role => `'${role.trim()}'`) : obj[key];
    }
  }
  return result;
}

async function initialize() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS age;`)
  await pool.query(`LOAD 'age';`)
  await pool.query(`SET search_path = ag_catalog, "$user", public;`)
  await pool.query(`
    SELECT CASE 
      WHEN NOT EXISTS (SELECT 1 FROM ag_catalog.ag_graph WHERE name = '${graph}') 
      THEN ag_catalog.create_graph('${graph}')
    END;
  `)
  await pool.query(`
    CREATE OR REPLACE FUNCTION check_user_access(
      p_user_id INT, 
      p_object_id INT, 
      p_object_type TEXT, 
      p_final_relationship TEXT
    )
    RETURNS BOOLEAN AS $func$
    DECLARE
      result BOOLEAN := FALSE;
      graph_name TEXT := '${graph}';
      cypher_query TEXT;
    BEGIN
      cypher_query := format($fmt$
        MATCH (us:Userset)
        MATCH (u:User {user_id: %s})-[r]->(o:Object {object_id: %s, namespace: %L})
        WHERE type(r) IN us[o.namespace + '.' + %L]
        RETURN true
        LIMIT 1
      $fmt$,
      p_user_id, p_object_id, p_object_type, p_final_relationship);

      EXECUTE format($exec$
        SELECT EXISTS (
          SELECT 1 FROM cypher(%L, $$%s$$) AS (result agtype)
        )
      $exec$, graph_name, cypher_query)
      INTO result;

      IF result THEN
        RETURN TRUE;
      END IF;

      cypher_query := format($fmt$
        MATCH (us:Userset)
        MATCH path = (User {user_id: %s})-[*]->(o:Object {object_id: %s, namespace: %L})
        WITH us, o, nodes(path) AS ns, relationships(path) AS rels, size(relationships(path)) AS rels_size, last(relationships(path)) AS last_rel
        WHERE type(last_rel) IN us[o.namespace + '.' + %L]
        UNWIND range(0, rels_size - 2) AS i
        WITH us, ns[i+1] as n, rels[i] as prev_rel, rels[i+1] AS next_rel, rels_size
        WHERE type(prev_rel) IN us[n.namespace + '.' + next_rel.relation]
        WITH count(1) AS valid_steps, rels_size
        WHERE valid_steps = rels_size - 1
        RETURN true
        LIMIT 1
      $fmt$,
      p_user_id, p_object_id, p_object_type, p_final_relationship);
      
      EXECUTE format($exec$
        SELECT EXISTS (
          SELECT 1 FROM cypher(%L, $$%s$$) AS (result agtype)
        )
      $exec$, graph_name, cypher_query)
      INTO result;

      IF result THEN
          RETURN TRUE;
      END IF;

      RETURN FALSE;
    END;
    $func$ LANGUAGE plpgsql;
  `)
}


async function loadUsersets(usersets) {
  const usersetsString = JSON.stringify(usersets).replace(/"/g, "")
  console.log(usersetsString)
  await pool.query(`
    SELECT * FROM cypher('${graph}', $$
      MERGE (u:Userset)
      SET u = ${usersetsString}
    $$) as (result agtype);
  `)
}

async function seed() {
  const fileStream = fs.createReadStream('seed.txt');
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    console.log(line)
    await createRelation(line)
  }
}

async function createRelation(relationTuple) {
  const [remainingTuple, userId] = relationTuple.split('@')
  const object = parseUserset(remainingTuple)

  if (/^\d+$/.test(userId)) {
    await createUserRelation({
      userId,
      relation: object.relation,
      objectId: object.objectId,
      namespace: object.namespace
    })
  } else {
    const userset = parseUserset(userId)
    await createObjectRelation({
      fromId: userset.objectId,
      fromNamespace: userset.namespace,
      fromRelation: userset.relation,
      toId: object.objectId,
      toNamespace: object.namespace,
      toRelation: object.relation
    })
  }
}

function parseUserset(userset) {
  const [object, relation] = userset.split('#')
  const [namespace, objectId] = object.split(':')
  return { objectId, namespace, relation }
}

async function deleteUser({ userId }) {
  await pool.query(`
    SELECT * FROM cypher('${graph}', $$
      MATCH (u:User {user_id: ${userId}})
      OPTIONAL MATCH (u)-[r]->()
      DELETE u, r
    $$) as (result agtype);
  `)
}

async function deleteObject({ objectId, namespace }) {
  await pool.query(`
    SELECT * FROM cypher('${graph}', $$
      MATCH (o:Object {object_id: ${objectId}, namespace: '${namespace}'})
      OPTIONAL MATCH (o)-[r]->()
      DELETE o, r
    $$) as (result agtype);
  `)
}

async function createUserRelation({ userId, relation, objectId, namespace}) {
  console.log(`createUserRelation: ${userId}, ${relation}, ${objectId}, ${namespace}`)
  await pool.query(`
    SELECT * FROM cypher('${graph}', $$
      MERGE (u:User {user_id: ${userId}})
      MERGE (o:Object {object_id: ${objectId}, namespace: '${namespace}'})
      MERGE (u)-[:${relation.toLowerCase()}]->(o)
    $$) as (result agtype);
  `)
}

async function deleteUserRelation({ userId, relation, objectId, namespace }) {
  await pool.query(`
    SELECT * FROM cypher('${graph}', $$
      MATCH (u:User {user_id: ${userId}})-[r:${relation.toLowerCase()}]->(o:Object {object_id: ${objectId}, namespace: '${namespace}'})
      DELETE r
    $$) as (result agtype);
  `)
}

async function createObjectRelation({ fromId, fromNamespace, fromRelation, toId, toNamespace, toRelation }) {
  console.log(`createObjectRelation: ${fromId}, ${fromNamespace}, ${fromRelation}, ${toId}, ${toNamespace}, ${toRelation}`)
  await pool.query(`
    SELECT * FROM cypher('${graph}', $$
      MERGE (o1:Object {object_id: ${fromId}, namespace: '${fromNamespace}'})
      MERGE (o2:Object {object_id: ${toId}, namespace: '${toNamespace}'})
      MERGE (o1)-[:${toRelation.toLowerCase()} {relation: '${fromRelation.toLowerCase()}'}]->(o2)
    $$) as (result agtype);
  `)
}

async function deleteObjectRelation({ fromId, fromNamespace, fromRelation, toId, toNamespace, toRelation }) {
  await pool.query(`
    SELECT * FROM cypher('${graph}', $$
      MATCH (o1:Object {object_id: ${fromId}, namespace: '${fromNamespace}'})-[r:${fromRelation.toLowerCase()} {relation: '${toRelation.toLowerCase()}'}]->(o2:Object {object_id: ${toId}, namespace: '${toNamespace}'})
      DELETE r
    $$) as (result agtype);
  `)
}

async function cleanup() {
  await pool.query(`
    SELECT * FROM cypher('${graph}', $$
      MATCH (n)
      OPTIONAL MATCH (n)-[r]->()
      DELETE n, r
    $$) as (result agtype);
  `)
}

async function checkUserAccess({ userId, resourceId, resourceType, relationship }) {
  const response = await pool.query(`SELECT check_user_access($1::INT, $2::INT, $3::TEXT, $4::TEXT)`, [userId, resourceId, resourceType, relationship])
  return response.rows?.[0]?.['check_user_access'] || false
}

await initialize()
await loadUsersets(usersets)
await seed()

const start = performance.now()
const response = await checkUserAccess({ userId: 2, resourceId: 1, resourceType: 'doc', relationship: 'viewer' })
const end = performance.now()
console.log(response, `${end - start}ms`)

// await cleanup()

pool.end()