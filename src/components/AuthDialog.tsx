import { useI18n } from '../i18n';
import { useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import type { Photo, User } from '../../shared/types';
import { AuthForm } from './AuthView';
import Modal from './Modal';
export type AuthIntent = 'login' | 'download' | 'favorite' | 'upload' | 'workspace' | 'postcard';
export interface AuthDialogProps {
  intent: AuthIntent;
  initialRegister?: boolean;
  photo?: Photo;
  onClose: () => void;
  onLogin: (user: User) => void;
}
const copy = {
  login: {
    title: '登录光影',
    login: '登录',
    register: '注册并登录',
    text: '登录后，继续整理和分享你的摄影作品。',
  },
  download: {
    title: '登录后下载展示图',
    login: '登录并继续下载',
    register: '注册并继续下载',
    text: '登录后，按作者许可下载这张照片的展示图。',
  },
  favorite: {
    title: '登录后收藏作品',
    login: '登录并收藏',
    register: '注册并收藏',
    text: '把喜欢的作品加入我的收藏，随时回来欣赏。',
  },
  upload: {
    title: '登录后上传照片',
    login: '登录并继续上传',
    register: '注册并继续上传',
    text: '登录你的创作空间，再将照片加入自己的相册。',
  },
  postcard: {
    title: '登录后导出明信片',
    login: '登录并继续制作',
    register: '注册并继续制作',
    text: '登录后，可按作者的下载许可导出明信片。当前照片和设置会为你保留。',
  },
  workspace: {
    title: '登录后进入我的相册',
    login: '登录并进入我的相册',
    register: '注册并进入我的相册',
    text: '你的私人相册、照片和选片结果都在自己的空间里。',
  },
} satisfies Record<
  AuthIntent,
  {
    title: string;
    login: string;
    register: string;
    text: string;
  }
>;
export default function AuthDialog({
  intent,
  photo,
  onClose,
  onLogin,
  initialRegister = false,
}: AuthDialogProps) {
  const { t } = useI18n();
  const [register, setRegister] = useState(initialRegister);
  const text = copy[intent];
  const contextPhoto = photo as
    | (Photo & {
        authorName?: string;
        albumTitle?: string;
      })
    | undefined;
  return (
    <Modal
      title={intent === 'login' && register ? t('开启你的创作空间') : t(text.title)}
      onClose={onClose}
    >
      <div className="auth-dialog">
        <p className="auth-dialog-intro">{t(text.text)}</p>
        {contextPhoto && (
          <div className="auth-dialog-photo">
            <img src={contextPhoto.thumbnailUrl || contextPhoto.previewUrl} alt="" />
            <div>
              <strong>{contextPhoto.filename}</strong>
              <span>
                {[contextPhoto.authorName, contextPhoto.albumTitle].filter(Boolean).join(' · ') ||
                  t('当前浏览的作品')}
              </span>
            </div>
          </div>
        )}
        <div className="auth-dialog-form">
          <AuthForm
            onLogin={onLogin}
            initialRegister={initialRegister}
            onModeChange={setRegister}
            loginLabel={text.login}
            registerLabel={text.register}
          />
        </div>
        <div className="auth-private">
          <LockKeyhole size={15} />
          <span>{t('登录不会离开当前页面，取消后仍可继续浏览。')}</span>
        </div>
        <button
          type="button"
          className="button button-secondary auth-dialog-cancel"
          onClick={onClose}
        >
          {t('暂不登录，继续浏览')}
        </button>
      </div>
    </Modal>
  );
}
