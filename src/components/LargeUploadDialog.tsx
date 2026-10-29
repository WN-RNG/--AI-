import { useState } from 'react';
import { Upload } from 'lucide-react';
import { formatBytes } from '../api';
import type { UploadFileInfo } from '../uploadPolicy';
import Modal from './Modal';

export default function LargeUploadDialog({
  files,
  normalCount,
  skippedErrors,
  onConfirm,
  onSkip,
  onCancel,
}: {
  files: readonly UploadFileInfo[];
  normalCount: number;
  skippedErrors: readonly string[];
  onConfirm: () => void;
  onSkip: () => void;
  onCancel: () => void;
}) {
  const [consented, setConsented] = useState(false);
  return (
    <Modal title="确认上传大照片" wide onClose={onCancel}>
      <p className="muted large-upload-intro">
        以下 {files.length} 张照片超过 20MB、未超过 30MB，上传和处理可能需要更久。
      </p>
      <ul className="large-upload-files" aria-label="需要确认的大照片">
        {files.map((file, index) => (
          <li key={`${file.name}:${file.size}:${index}`}>
            <span className="large-upload-file-name">{file.name}</span>
            <span className="large-upload-file-size">{formatBytes(file.size)}</span>
          </li>
        ))}
      </ul>
      <p className="muted small-text large-upload-note">
        {normalCount ? `另有 ${normalCount} 张普通照片可正常上传。` : '本次没有普通照片。'}
        {skippedErrors.length > 0 &&
          `已剔除 ${skippedErrors.length} 个格式不支持或超过 30MB 的文件。`}
        本次确认不会应用到以后的上传。
      </p>
      {skippedErrors.length > 0 && (
        <details className="large-upload-skipped">
          <summary>查看已跳过的文件</summary>
          <ul>
            {skippedErrors.map((error, index) => (
              <li key={index}>{error}</li>
            ))}
          </ul>
        </details>
      )}
      <label className="large-upload-consent">
        <input
          type="checkbox"
          checked={consented}
          onChange={(event) => setConsented(event.target.checked)}
        />
        <span>我同意本次上传以上大照片。</span>
      </label>
      <div className="modal-actions large-upload-actions">
        <button type="button" className="button button-secondary" onClick={onCancel}>
          取消全部
        </button>
        <button
          type="button"
          className="button button-secondary"
          onClick={onSkip}
          disabled={!normalCount}
        >
          跳过大照片，仅上传普通照片
        </button>
        <button
          type="button"
          className="button button-primary"
          disabled={!consented}
          onClick={() => {
            if (consented) onConfirm();
          }}
        >
          <Upload size={16} />
          确认上传本次照片
        </button>
      </div>
    </Modal>
  );
}
