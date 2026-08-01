export const CLIENT_ENGINE_ASSETS = {
  'rife-ncnn-vulkan-20221029-windows-lite.zip': {
    size: 123_750_542,
    sha256: 'A4DA55EC5629DBD5E9C6594D96225308325FC39A3DF67CD8E77010207525CE77',
    sourceUrl: 'https://github.com/jiuqu1122-ops/inspiration-drawer/releases/download/engine-rife-20221029/rife-ncnn-vulkan-20221029-windows-lite.zip',
  },
  'ffmpeg-tools-n8.1-win64-gpl.zip': {
    size: 109_205_730,
    sha256: 'D4B1D805749E6FA174E4BE158E844AD93BACBF23C2C68EDD473EEBE96B09CA63',
    sourceUrl: 'https://github.com/jiuqu1122-ops/inspiration-drawer/releases/download/engine-rife-20221029/ffmpeg-tools-n8.1-win64-gpl.zip',
  },
  'realesrgan-ncnn-vulkan-20220424-windows.zip': {
    size: 45_474_481,
    sha256: 'ABC02804E17982A3BE33675E4D471E91EA374E65B70167ABC09E31ACB412802D',
    sourceUrl: 'https://github.com/jiuqu1122-ops/inspiration-drawer/releases/download/engine-realesrgan-20220424/realesrgan-ncnn-vulkan-20220424-windows.zip',
  },
} as const;

export type ClientEngineAssetName = keyof typeof CLIENT_ENGINE_ASSETS;

export function getClientEngineAsset(name: string) {
  if (!Object.prototype.hasOwnProperty.call(CLIENT_ENGINE_ASSETS, name)) return null;
  const assetName = name as ClientEngineAssetName;
  return {
    name: assetName,
    objectName: `client-assets/${assetName}`,
    ...CLIENT_ENGINE_ASSETS[assetName],
  };
}
