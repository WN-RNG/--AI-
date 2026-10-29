/**
 * 认证页面：处理登录与邀请注册，并把成功登录的用户交给 App。
 * 逐文件说明见项目根目录《项目结构与代码说明.md》。
 */

import { useState, type FormEvent } from 'react';
import { Aperture, ArrowUpRight, LockKeyhole, LoaderCircle } from 'lucide-react';
import { api } from '../api';
import type { User } from '../../shared/types';

export default function AuthView({
  onLogin,
  onExplore,
}: {
  onLogin: (user: User) => void;
  onExplore: () => void;
}) {
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const form = Object.fromEntries(new FormData(e.currentTarget).entries());
    try {
      const data = await api<{ user: User }>(register ? '/auth/register' : '/auth/login', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      onLogin(data.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
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
            {'探索公开作品 '}
            <ArrowUpRight size={18} />
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
          <form onSubmit={submit} className="form-stack">
            {register && (
              <label>
                称呼
                <input
                  name="name"
                  placeholder="我们该如何称呼你"
                  autoComplete="name"
                  required
                  maxLength={60}
                />
              </label>
            )}
            <label>
              邮箱
              <input
                name="email"
                type="email"
                placeholder="you@example.com"
                autoComplete="email"
                required
                maxLength={254}
              />
            </label>
            <label>
              密码
              <input
                name="password"
                type="password"
                placeholder={register ? '至少 8 位字符' : '输入你的密码'}
                minLength={register ? 8 : undefined}
                autoComplete={register ? 'new-password' : 'current-password'}
                required
                maxLength={128}
              />
            </label>
            {register && (
              <label>
                邀请码
                <input
                  name="inviteCode"
                  placeholder="输入受邀获得的邀请码"
                  required
                  autoComplete="off"
                />
              </label>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="button button-primary auth-submit" disabled={busy}>
              {busy ? (
                <LoaderCircle className="spin" size={18} />
              ) : (
                <>
                  {register ? '创建空间' : '进入工作台'}
                  <ArrowUpRight size={19} />
                </>
              )}
            </button>
          </form>
          <p className="auth-toggle">
            {register ? '已有账号？' : '首次来到这里？'}
            <button
              className="text-button"
              onClick={() => {
                setRegister(!register);
                setError('');
              }}
            >
              {register ? '登录' : '受邀注册'}
            </button>
          </p>
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
