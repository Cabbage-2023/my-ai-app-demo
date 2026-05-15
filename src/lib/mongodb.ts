import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI!;

// Next.js 热重载时复用连接，避免每次刷新都新建
const cached = (globalThis as any)._mongooseConn ?? { conn: null, promise: null };
(globalThis as any)._mongooseConn = cached;


// connectDB()：调用时返回已有的或新建的连接
async function connectDB() {
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    cached.promise = mongoose.connect(MONGODB_URI, {});
  }

  cached.conn = await cached.promise;
  return cached.conn;
}

export default connectDB;