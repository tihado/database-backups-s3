require("dotenv").config();
const util = require("util");
const exec = util.promisify(require("child_process").exec);
const s3 = require("@aws-sdk/client-s3");
const fs = require("fs");
const cron = require("cron");

function loadConfig() {
  const requiredEnvars = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_S3_REGION",
    "AWS_S3_ENDPOINT",
    "AWS_S3_BUCKET",
  ];

  for (const key of requiredEnvars) {
    if (!process.env[key]) {
      throw new Error(`Environment variable ${key} is required`);
    }
  }

  return {
    aws: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_S3_REGION,
      endpoint: process.env.AWS_S3_ENDPOINT,
      s3_bucket: process.env.AWS_S3_BUCKET,
    },
    databases: process.env.DATABASES ? process.env.DATABASES.split(",") : [],
    run_on_startup: process.env.RUN_ON_STARTUP === "true",
    cron: process.env.CRON,
    retentionDays: Number(process.env.RETENTION_DAYS),
  };
}

const config = loadConfig();

const s3Client = new s3.S3Client(config.aws);

async function processBackup() {
  if (config.databases.length === 0) {
    console.log("No databases defined.");
    return;
  }

  for (const [index, databaseURI] of config.databases.entries()) {
    const databaseIteration = index + 1;
    const totalDatabases = config.databases.length;

    const url = new URL(databaseURI);
    const dbType = url.protocol.slice(0, -1); // remove trailing colon
    const dbName = url.pathname.substring(1); // extract db name from URL
    const dbHostname = url.hostname;
    const dbUser = url.username;
    const dbPassword = url.password;
    const dbPort = url.port;

    const date = new Date();
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const min = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");
    const timestamp = `${yyyy}-${mm}-${dd}_${hh}:${min}:${ss}`;
    const filename = `backup-${dbType}-${timestamp}-${dbName}-${dbHostname}.tar.gz`;
    const filepath = `/tmp/${filename}`;

    console.log(
      `\n[${databaseIteration}/${totalDatabases}] ${dbType}/${dbName} Backup in progress...`
    );

    let dumpCommand;
    let versionCommand = 'echo "Unknown database type"';
    switch (dbType) {
      case "postgresql":
        dumpCommand = `pg_dump "${databaseURI}" -F c > "${filepath}.dump"`;
        versionCommand = "psql --version";
        break;
      case "mongodb":
        dumpCommand = `mongodump --uri="${databaseURI}" --archive="${filepath}.dump"`;
        versionCommand = "mongodump --version";
        break;
      case "mysql":
        dumpCommand = `mysqldump -u ${dbUser} -p${dbPassword} -h ${dbHostname} -P ${dbPort} ${dbName} > "${filepath}.dump"`;
        versionCommand = "mysql --version";
        break;
      default:
        console.log(`Unknown database type: ${dbType}`);
        return;
    }

    try {
      // Log database client version
      try {
        const { stdout: versionOutput } = await exec(versionCommand);
        console.log(`Using ${dbType} client version:`, versionOutput.trim());
      } catch (versionError) {
        console.warn(
          `Failed to get ${dbType} client version:`,
          versionError.message
        );
      }

      // 1. Execute the dump command
      await exec(dumpCommand);

      // 2. Compress the dump file
      await exec(`tar -czvf ${filepath} ${filepath}.dump`);

      // 3. Read the compressed file
      const data = fs.readFileSync(filepath);

      // 4. Upload to S3
      const params = {
        Bucket: config.aws.s3_bucket,
        Key: filename,
        Body: data,
      };

      const putCommand = new s3.PutObjectCommand(params);
      await s3Client.send(putCommand);

      console.log(
        `✓ Successfully uploaded db backup for database ${dbType} ${dbName} ${dbHostname}.`
      );

      // 5. Clean up temporary files
      await exec(`rm -f ${filepath} ${filepath}.dump`);
    } catch (error) {
      console.error(
        `An error occurred while processing the database ${dbType} ${dbName}, host: ${dbHostname}: ${error}`
      );
    }
  }
}

async function processClearOldFiles() {
  if (!config.retentionDays || Number.isNaN(config.retentionDays)) {
    return;
  }
  const endDate = new Date(
    new Date().getDate() - config.retentionDays * 24 * 60 * 60 * 1000
  );

  try {
    // 1. Get list of backup file
    const params = {
      Bucket: config.aws.s3_bucket,
    };
    const getListCommand = new s3.ListObjectsV2Command(params);
    const { Contents, IsTruncated } = await s3Client.send(getListCommand);

    // TODO: handle truncate

    // 2. Filter old files
    const removeFiles = Contents?.reduce((acc, file) => {
      const fileDate = new Date(file.LastModified);
      if (fileDate < endDate) {
        acc.push(file.Key);
      }
      return acc;
    }, []);

    // 3. Remove old file
    if (!removeFiles.length) {
      console.log("No old files to remove.");
      return;
    }
    const deleteParams = {
      Bucket: config.aws.s3_bucket,
      Delete: {
        Objects: removeFiles.map((Key) => ({ Key })),
      },
    };

    const deleteCommand = new s3.DeleteObjectsCommand(deleteParams);
    await s3Client.send(deleteCommand);

    console.log(
      `✓ Successfully removed ${removeFiles.length} old backup files.`
    );
  } catch (error) {
    console.error(
      `An error occurred while processing clear old backup files: ${error}`
    );
  }
}

async function processJob() {
  await Promise.all([processBackup(), processClearOldFiles()]);
}

if (config.cron) {
  const CronJob = cron.CronJob;
  const job = new CronJob(config.cron, processJob);
  job.start();

  console.log(`Backups configured on Cron job schedule: ${config.cron}`);
}

if (config.run_on_startup) {
  console.log("run_on_startup enabled, backing up now...");
  processJob();
}
