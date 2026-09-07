import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * 应用级错误边界：任何页面渲染异常都不应让整个工作台白屏。
 * 生产环境只显示中文提示与两个出路（重新加载 / 返回论文项目）；
 * 开发环境额外折叠显示错误消息与组件栈，便于定位。
 */

interface Props {
  children: ReactNode;
  /** 路由变化时传入新 key 可重置边界（离开出错页面后恢复正常渲染） */
  resetKey?: string;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    console.error("[paperteam] 页面渲染异常：", error);
  }

  override componentDidUpdate(previous: Props): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null, componentStack: null });
    }
  }

  override render(): ReactNode {
    const { error, componentStack } = this.state;
    if (error === null) {
      return this.props.children;
    }
    return (
      <section className="page" role="alert" data-testid="app-error-boundary">
        <div className="error-boundary">
          <h1 className="page-title">页面出现异常</h1>
          <p className="muted">
            这个页面在渲染时出错了。你的数据没有丢失：重新加载通常可以恢复；如果反复出现，请返回论文项目并反馈。
          </p>
          <div className="action-row">
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
              重新加载
            </button>
            <Link to="/projects" className="btn" onClick={() => this.setState({ error: null, componentStack: null })}>
              返回论文项目
            </Link>
          </div>
          {import.meta.env.DEV ? (
            <details className="details-block" style={{ marginTop: "var(--s-5)" }}>
              <summary>错误详情（仅开发环境显示）</summary>
              <pre className="details-body error-boundary-detail">
                {error.message}
                {componentStack !== null ? `\n${componentStack}` : ""}
              </pre>
            </details>
          ) : null}
        </div>
      </section>
    );
  }
}
