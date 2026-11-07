/** 登录页与认证弹窗共享表单；认证成功后的操作接续由 App 决定。 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Aperture, ArrowUpRight, LockKeyhole, LoaderCircle } from 'lucide-react';
import { api } from '../api';
import type { User } from '../../shared/types';

export interface AuthFormProps {
  onLogin: (user: User) => void;
  loginLabel?: string;
  registerLabel?: string;
  onModeChange?: (register: boolean) => void;
}

export function AuthForm({
  onLogin,
  loginLabel = '进入工作台',
  registerLabel = '创建空间',
  onModeChange,
}: AuthFormProps) {
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [values, setValues] = useState({ name: '', email: '', password: '', inviteCode: '' });
  const requestRef = useRef<AbortController | null>(null);
  const submittingRef = useRef(false);
  useEffect(() => () => requestRef.current?.abort(), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const form = register ? values : { email: values.email, password: values.password };
      const data = await api<{ user: User }>(register ? '/auth/register' : '/auth/login', {
        method: 'POST',
        body: JSON.stringify(form),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) onLogin(data.user);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : '认证未完成，请重试。');
    } finally {
      submittingRef.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const change = (field: keyof typeof values, value: string) =>
    setValues((current) => ({ ...current, [field]: value }));
  return (
    <>
      <form onSubmit={submit} className="form-stack" aria-busy={busy}>
        {register && (
          <label>
            称呼
            <input
              name="name"
              value={values.name}
              onChange={(event) => change('name', event.target.value)}
              placeholder="我们该如何称呼你"
              autoComplete="name"
              required
              maxLength={60}
              disabled={busy}
            />
          </label>
        )}
        <label>
          邮箱
          <input
            name="email"
            type="email"
            value={values.email}
            onChange={(event) => change('email', event.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            required
            maxLength={254}
            disabled={busy}
          />
        </label>
        <label>
          密码
          <input
            name="password"
            type="password"
            value={values.password}
            onChange={(event) => change('password', event.target.value)}
            placeholder={register ? '至少 8 位字符' : '输入你的密码'}
            minLength={register ? 8 : undefined}
            autoComplete={register ? 'new-password' : 'current-password'}
            required
            maxLength={128}
            disabled={busy}
          />
        </label>
        {register && (
          <label>
            邀请码
            <input
              name="inviteCode"
              value={values.inviteCode}
              onChange={(event) => change('inviteCode', event.target.value)}
              placeholder="输入受邀获得的邀请码"
              required
              autoComplete="off"
              disabled={busy}
            />
          </label>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="button button-primary auth-submit" type="submit" disabled={busy}>
          {busy ? (
            <>
              <LoaderCircle className="spin" size={18} />
              正在验证
            </>
          ) : (
            <>
              {register ? registerLabel : loginLabel}
              <ArrowUpRight size={19} />
            </>
          )}
        </button>
      </form>
      <p className="auth-toggle">
        {register ? '已有账号？' : '首次来到这里？'}
        <button
          className="text-button"
          type="button"
          disabled={busy}
          onClick={() => {
            const next = !register;
            setRegister(next);
            setError('');
            onModeChange?.(next);
          }}
        >
          {register ? '登录' : '受邀注册'}
        </button>
      </p>
    </>
  );
}

export default function AuthView({
  onLogin,
  onExplore,
}: {
  onLogin: (user: User) => void;
  onExplore: () => void;
}) {
  const [register, setRegister] = useState(false);
  return (
    <main className="auth-screen">
      <div className="auth-photo" style={{ backgroundImage: 'url(/demo/kyoto-temple.png)' }}>
        <a href="/" className="brand">
          <Aperture size={30} />
          <span>
            光影<span className="brand-separator">/</span>
            <small>AI 相册</small>
          </span>
        </a>
        <div className="auth-editorial">
          <p className="eyebrow">A SPACE FOR YOUR VISION</p>
          <h1>
            让每一帧，
            <br />
            都值得珍藏。
          </h1>
          <p>
            整理拍摄的瞬间，留下最好的作品。
            <br />
            在光影之间，找到属于你的表达。
          </p>
          <button className="text-button" onClick={onExplore}>
            探索公开作品 <ArrowUpRight size={18} />
          </button>
        </div>
        <div className="auth-photo-footer">
          <span>YOUR PHOTOGRAPHS. YOUR PERSPECTIVE.</span>
          <span>01 / KYOTO</span>
        </div>
      </div>
      <section className="auth-panel">
        <div className="auth-form-wrap">
          <p className="eyebrow">THE CREATOR'S WORKSPACE</p>
          <h2>{register ? '开启你的创作空间' : '欢迎回到光影'}</h2>
          <p className="muted">
            {register ? '使用邀请码，创建你的私密摄影空间。' : '你的照片、灵感与作品，在这里相遇。'}
          </p>
          <AuthForm onLogin={onLogin} onModeChange={setRegister} />
          <div className="auth-private">
            <LockKeyhole size={16} />
            <span>照片默认私密，由你决定哪些作品公开。</span>
          </div>
        </div>
        <span className="auth-footer">光影 / 为摄影创作者而设计</span>
      </section>
    </main>
  );
}
