// session/store.ts —— 通用状态容器（框架代码，与具体状态机无关）。
// 本质就是给 Map<string, S> 套一层类型安全的壳：按 key 存取一份状态。
// 「谁和谁共享同一份状态」不由这里决定，而由调用方传进来的 key 决定（见 session/key.ts）。
//
// 泛型 <S>：存什么类型的状态，由使用它的人指定。猜数字模块 new SessionStore<GuessState>()，
// 以后别的状态机 new SessionStore<XxxState>()，同一个类、各存各的、各自类型安全。
// 类比 Python 的 dict[str, S]，但 TS 的 <S> 编译期真的会拦——塞错类型直接报错。
//
// ⚠️ 存在内存里：进程重启（每次自动部署发版）状态即清空。短命会话够用；
//   要持久记忆，日后换成文件/数据库实现同一组方法即可，调用方无感。

export class SessionStore<S> {
  private readonly map = new Map<string, S>();

  // 拿不到返回 undefined——调用方据此区分「有没有正在进行的会话」。
  get(key: string): S | undefined {
    return this.map.get(key);
  }

  set(key: string, state: S): void {
    this.map.set(key, state);
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}
