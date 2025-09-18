import fs from "node:fs";
import chalk from "chalk";

const files = fs
  .readdirSync("./plugins/YunKit-plugin/apps", { recursive: true })
  .filter((file) => file.endsWith(".js"));

let ret = [];

files.forEach((file) => {
  ret.push(import(`./apps/${file}`));
});

ret = await Promise.allSettled(ret);

let apps = {};
for (let i in files) {
  let name = files[i].replace(".js", "");

  if (ret[i].status != "fulfilled") {
    logger.error(
      chalk.bgRed.white(` [YunKit-plugin] 插件载入失败 `) +
      chalk.red(` 【${name}】`)
    );
    logger.error(
      chalk.red("原因: ") +
      (ret[i].reason && ret[i].reason.stack ? ret[i].reason.stack : ret[i].reason)
    );
    continue;
  }
  apps[name] = ret[i].value[Object.keys(ret[i].value)[0]];
}

logger.info(
  chalk.green("- YunKit插件载入成功") 
);

export { apps };
