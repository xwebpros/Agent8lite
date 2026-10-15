import { generateKeyPairSync } from "node:crypto";
import presets from "../contracts/role-presets.json";
import permissionCatalog from "../contracts/permission-catalog.json";
import { fixtures as f, roleId, stageId } from "./fixtures";
import { databaseConnectionString, migrationPool } from "./pool";
import { seedNativeReadFixtures } from "./seed-native-read-fixtures";

export async function seed() {
  if (!["development", "test"].includes(process.env.APP_ENV ?? "") || process.env.DEV_AUTH_ENABLED !== "true")
    throw new Error("Synthetic fixtures require explicitly enabled development or test mode.");
  const target = new URL(databaseConnectionString("migration"));
  if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname))
    throw new Error("Synthetic fixtures may only be seeded to a loopback database.");
  const pool = migrationPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(874522)");
    for (const [id, subject, displayName] of [
      [f.ownerUser, "owner", "Synthetic Owner"],
      [f.agentUser, "agent", "Synthetic Agent"],
      [f.otherAgentUser, "other-agent", "Synthetic Other Agent"],
      [f.staffAdministratorUser, "staff-administrator", "Synthetic Staff Administrator"],
      [f.staffSupportUser, "staff-support", "Synthetic Staff Support"],
    ]) {
      await client.query(
        `INSERT INTO app.user_identity(id,issuer,subject,display_name,email,email_verified) VALUES($1,'urn:estate:synthetic',$2,$3,$4,true) ON CONFLICT(id) DO NOTHING`,
        [id, subject, displayName, `${subject}@example.test`],
      );
    }
    for (const [user, codes] of [
      [
        f.staffAdministratorUser,
        permissionCatalog.codes.filter((entry) => entry.boundary === "staff").map((entry) => entry.code),
      ],
      [f.staffSupportUser, ["platform.orgs.read", "platform.health.read", "platform.config.read"]],
    ] as const)
      await client.query(
        "INSERT INTO app.staff_principal(user_id,permission_codes,active)VALUES($1,$2,true)ON CONFLICT(user_id)DO NOTHING",
        [user, codes],
      );
    for (const [index, code, interval, price] of [
      [1, "synthetic-starter", "month", 4900],
      [2, "synthetic-starter", "year", 49000],
      [3, "synthetic-team", "month", 9900],
      [4, "synthetic-team", "year", 99000],
    ] as const) {
      await client.query(
        `INSERT INTO app.plan(id,code,name,price_minor,currency,billing_interval,features,limits)VALUES($1,$2,$3,$4,'USD',$5,'{"crm":true,"synthetic":true}','{"members":25}')ON CONFLICT DO NOTHING`,
        [
          `a0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          code,
          `${code} · No charges`,
          price,
          interval,
        ],
      );
    }
    for (const [index, org, name] of [
      [1, f.orgA, "Harbor Realty · Synthetic"],
      [2, f.orgB, "Pine Realty · Synthetic"],
    ] as const) {
      await client.query(
        `INSERT INTO app.organization(id,name,status) VALUES($1,$2,'active') ON CONFLICT(id) DO NOTHING`,
        [org, name],
      );
      await client.query("INSERT INTO app.crm_routing_state(tenant_id)VALUES($1)ON CONFLICT DO NOTHING", [
        org,
      ]);
      for (const [roleIndex, role] of presets.presets.entries())
        await client.query(
          `INSERT INTO app.role_definition(tenant_id,id,name,permission_grants,builtin) VALUES($1,$2,$3,$4,true) ON CONFLICT DO NOTHING`,
          [org, roleId(index, roleIndex + 1), role.name, JSON.stringify(role.permissions)],
        );
      const ownerMember = index === 1 ? f.ownerMemberA : f.ownerMemberB;
      const agentMember = index === 1 ? f.agentMemberA : f.agentMemberB;
      await client.query(
        `INSERT INTO app.membership(tenant_id,id,user_id,role_id,status,display_name) VALUES($1,$2,$3,$4,'active','Synthetic Owner') ON CONFLICT DO NOTHING`,
        [org, ownerMember, f.ownerUser, roleId(index, 1)],
      );
      await client.query(
        `INSERT INTO app.membership(tenant_id,id,user_id,role_id,status,display_name) VALUES($1,$2,$3,$4,'active','Synthetic Agent') ON CONFLICT DO NOTHING`,
        [org, agentMember, index === 1 ? f.agentUser : f.otherAgentUser, roleId(index, 3)],
      );
      // Explicit synthetic default precedence. Listing attribution has no resolver and falls through.
      for (const [offset, kind] of ["first_touch", "listing_agent", "round_robin"].entries()) {
        await client.query(
          "INSERT INTO app.routing_rule(tenant_id,id,priority,condition,assignment)VALUES($1,$2,$3,$4,$5)ON CONFLICT DO NOTHING",
          [
            org,
            `c1000000-0000-4000-8000-${String(index * 100 + offset + 1).padStart(12, "0")}`,
            offset === 2 ? 30 : offset * 10,
            JSON.stringify({ kind, retired: false }),
            JSON.stringify(
              kind === "round_robin"
                ? {
                    memberWeights: [
                      { memberId: ownerMember, weight: 1 },
                      { memberId: agentMember, weight: 1 },
                    ],
                  }
                : {},
            ),
          ],
        );
      }
      const stages = ["Uncontacted", "Attempted Contact", "Nurturing", "Dead", "Under Contract", "Closed"];
      for (const [position, stage] of stages.entries())
        await client.query(
          `INSERT INTO app.pipeline_stage(tenant_id,id,name,position,terminal) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [org, stageId(index, position + 1), stage, position, position === 3 || position === 5],
        );
      await client.query(
        `INSERT INTO app.business_profile(tenant_id,name) SELECT $1,$2 WHERE NOT EXISTS(SELECT 1 FROM app.business_profile WHERE tenant_id=$1)`,
        [org, name],
      );
      const source = index === 1 ? f.sourceA : f.sourceB;
      const contact = index === 1 ? f.contactA : f.contactB;
      const lead = index === 1 ? f.leadA : f.leadB;
      const task = index === 1 ? f.taskA : f.taskB;
      await client.query(
        `INSERT INTO app.lead_source(tenant_id,id,code,label) VALUES($1,$2,'synthetic-inquiry','Synthetic website inquiry') ON CONFLICT DO NOTHING`,
        [org, source],
      );
      await client.query(
        `INSERT INTO app.contact(tenant_id,id,display_name,created_by_member_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [org, contact, index === 1 ? "Jamie Rivera · Synthetic" : "Taylor Chen · Synthetic", agentMember],
      );
      await client.query(
        `INSERT INTO app.contact_channel(tenant_id,contact_id,kind,normalized_value,is_primary) VALUES($1,$2,'email',$3,true) ON CONFLICT DO NOTHING`,
        [org, contact, index === 1 ? "jamie@example.test" : "taylor@example.test"],
      );
      await client.query(
        `INSERT INTO app.lead(tenant_id,id,contact_id,source_id,stage_id,owner_member_id,intent,timeline,attribution) VALUES($1,$2,$3,$4,$5,$6,'buyer','3–6 months','{"synthetic":true,"source":"fixture"}') ON CONFLICT DO NOTHING`,
        [org, lead, contact, source, stageId(index, 1), agentMember],
      );
      await client.query(
        `INSERT INTO app.task(tenant_id,id,lead_id,assignee_member_id,title,due_at,due_timezone,priority,state) VALUES($1,$2,$3,$4,'Follow up with synthetic buyer',now()+interval '1 day','America/Los_Angeles','normal','open') ON CONFLICT DO NOTHING`,
        [org, task, lead, agentMember],
      );
      await client.query(
        `INSERT INTO app.entitlement(tenant_id,feature,state) VALUES($1,'crm','enabled') ON CONFLICT DO NOTHING`,
        [org],
      );
      await client.query(
        `INSERT INTO app.entitlement(tenant_id,feature,state)VALUES($1,'billing','enabled')ON CONFLICT DO NOTHING`,
        [org],
      );
      await client.query(
        `INSERT INTO app.subscription(tenant_id,id,plan_id,status,period_end)VALUES($1,$2,'a0000000-0000-4000-8000-000000000001','mock_active',now()+interval '30 days')ON CONFLICT DO NOTHING`,
        [org, `b0000000-0000-4000-8000-${String(index).padStart(12, "0")}`],
      );
      await client.query(
        `INSERT INTO app.integration_connection(tenant_id,provider,mode,state,safe_config)SELECT $1,'stripe','mock','ready','{"synthetic":true,"realCharges":false}'WHERE NOT EXISTS(SELECT 1 FROM app.integration_connection WHERE tenant_id=$1 AND provider='stripe')`,
        [org],
      );
      await client.query(
        `INSERT INTO app.integration_connection(tenant_id,provider,mode,state,safe_config) SELECT $1,'trestle','mock','mock','{"synthetic":true,"liveFeedRights":"unapproved"}' WHERE NOT EXISTS(SELECT 1 FROM app.integration_connection WHERE tenant_id=$1 AND provider='trestle')`,
        [org],
      );
    }
    await seedNativeReadFixtures(client);
    const existingVapid = await client.query(
      `SELECT 1 FROM app.instance_config WHERE key='vapid_public_key'`,
    );
    if (!existingVapid.rowCount) {
      const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const pubRaw = publicKey.export({ type: "spki", format: "der" });
      const uncompressed = pubRaw.subarray(pubRaw.length - 65);
      const pubB64 = Buffer.from(uncompressed).toString("base64url");
      const privJwk = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
      await client.query(
        `INSERT INTO app.instance_config(key,value) VALUES('vapid_public_key',$1),('vapid_private_key',$2) ON CONFLICT(key) DO NOTHING`,
        [pubB64, privJwk],
      );
      console.log("Generated synthetic VAPID key pair for push notifications.");
    }
    await client.query("COMMIT");
    console.log("Seeded two organizations and synthetic identities; no external services contacted.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/seed.ts"))
  seed().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
