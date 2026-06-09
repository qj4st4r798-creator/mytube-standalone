require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

// ✅ Always use the correct file in /data
const sourcePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, "../data/users.json");

console.log("Loading JSON from:", sourcePath);

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  }

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source file not found: ${sourcePath}`);
  }

  const users = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  if (!Array.isArray(users)) {
    throw new Error("Source file must contain a JSON array of users.");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  for (const user of users) {
    const { email, full_name, channel_name, password_hash, password_salt, role, created_at } = user;
    if (!email) {
      console.warn("Skipping user without email:", user);
      continue;
    }

    const { data: createdUser, error: createError } = await supabase.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: {
        full_name,
        channel_name,
        password_hash,
        password_salt,
      },
    });

    if (createError) {
      console.error(`Failed to create auth user for ${email}:`, createError.message);
      continue;
    }

    const authUserId = createdUser?.user?.id;
    if (!authUserId) {
      console.error(`Supabase did not return a user id for ${email}.`);
      continue;
    }

    const { error: profileError } = await supabase
      .from("profiles")
      .insert({
        id: authUserId,
        full_name,
        channel_name,
        role,
        created_at,
        password_hash,
        password_salt,
      });

    if (profileError) {
      console.error(`Failed to create profile for ${email}:`, profileError.message);
      continue;
    }

    console.log(`Imported ${email} -> ${authUserId}`);
  }

  console.log("✅ Import complete!");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
