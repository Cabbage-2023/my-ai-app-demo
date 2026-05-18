import { MemorySaver } from "@langchain/langgraph";

/**
 * 创建 LangGraph 检查点（checkpoint）持久化实例。
 *
 * 当前使用 MemorySaver（进程内内存，重启丢失），
 * 后续可升级为 MongoDB / Postgres 持久化以支持跨 session 记忆：
 *
 * ```ts
 * import { MongoClient } from "mongodb";
 * // 需要额外安装 @langchain/langgraph-checkpoint-mongodb
 * const client = new MongoClient(process.env.MONGODB_URI!);
 * await client.connect();
 * return MongoDBSaver.fromClient(client);
 * ```
 *
 * MemorySaver 对于开发/演示阶段足够，生产部署前替换即可。
 */
export function createCheckpointer() {
  return new MemorySaver();
}
