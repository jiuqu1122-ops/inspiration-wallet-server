import { describe, expect, it } from 'vitest';
import { parseEnvironment } from '../src/config/env.js';

function productionEnv() {
  return {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    STORAGE_SIGNED_URL_EXPIRES_SECONDS: '3600',
  };
}

describe('object storage environment validation', () => {
  it('requires only the selected Tencent COS credentials in production', () => {
    const value = parseEnvironment({
      ...productionEnv(),
      STORAGE_PROVIDER: 'tencent-cos',
      COS_REGION: 'ap-singapore',
      COS_BUCKET: 'inspirationdrawer-1475663212',
      COS_SECRET_ID: 'cos-id',
      COS_SECRET_KEY: 'cos-secret',
      OSS_REGION: '',
      OSS_BUCKET: '',
      OSS_ACCESS_KEY_ID: '',
      OSS_ACCESS_KEY_SECRET: '',
    });

    expect(value.STORAGE_PROVIDER).toBe('tencent-cos');
    expect(value.COS_BUCKET).toBe('inspirationdrawer-1475663212');
  });

  it('requires only the selected Aliyun OSS credentials in production', () => {
    const value = parseEnvironment({
      ...productionEnv(),
      STORAGE_PROVIDER: 'aliyun-oss',
      OSS_REGION: 'oss-cn-hongkong',
      OSS_BUCKET: 'test-bucket',
      OSS_ACCESS_KEY_ID: 'oss-id',
      OSS_ACCESS_KEY_SECRET: 'oss-secret',
      COS_REGION: '',
      COS_BUCKET: '',
      COS_SECRET_ID: '',
      COS_SECRET_KEY: '',
    });

    expect(value.STORAGE_PROVIDER).toBe('aliyun-oss');
  });

  it('rejects missing credentials for the selected provider without exposing values', () => {
    expect(() => parseEnvironment({
      ...productionEnv(),
      STORAGE_PROVIDER: 'tencent-cos',
      COS_REGION: 'ap-singapore',
      COS_BUCKET: 'inspirationdrawer-1475663212',
      COS_SECRET_ID: 'secret-id-must-not-appear',
      COS_SECRET_KEY: '',
    })).toThrow(/COS_SECRET_KEY: is required/);
  });
});
