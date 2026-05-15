import mongoose, { Schema, Document } from 'mongoose';

// 1. IResource：TypeScript 类型定义
//    metadata 用 Record<string, any>，可以存任意字段
//    存 galgame 角色时: { name: "古河渚", source: "Bangumi", type: "character" }
//    存商品时:        { name: "iPhone 15", category: "电子产品", price: 5999 }
//    存文档时:        { title: "项目报告", author: "张三", date: "2025-01-01" }
export interface IResource extends Document {
  content: string;           // 文本内容
  embedding: number[];       // 向量
  metadata: Record<string, any>;  // 任意附加信息，不限字段
}

// 2. Schema：MongoDB 存储格式
//    metadata 用 type: Map, of: String 表示"不限字段名，值统一存字符串"
//    注意：虽然 TypeScript 是 Record<string, any>，但 MongoDB 存下来值会转成实际类型
const ResourceSchema = new Schema<IResource>({
  content: { type: String, required: true },
  embedding: { type: [Number], required: true },
  metadata: { type: Map, of: Schema.Types.Mixed, default: {} },
});

// 3. 导出 Model（热重载兼容）
export const Resource =
  mongoose.models.Resource ?? mongoose.model<IResource>('Resource', ResourceSchema);

// 简单总结三者的关系：

// IResource  (TypeScript接口)      ← 写代码时 Ctrl+空格 能看到提示
//     ↓ 约束
// ResourceSchema (Mongoose Schema) ← 运行时校验数据格式
//     ↓ 生成
// Resource (Model)                  ← 真正用来操作数据库的 API
//                                       Resource.find() / Resource.create() ...