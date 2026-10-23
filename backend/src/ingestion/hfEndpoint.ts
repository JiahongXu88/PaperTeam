/**
 * M15.3.3 B3.5：HF 模型下载端点缺省解析（纯函数，无网络）。
 *
 * 国内网络首次运行 docling 需要从 HuggingFace 下载模型，缺省走 hf-mirror；
 * 只要 HF_ENDPOINT 被显式设置（如 CI 中显式指定官方源 https://huggingface.co，
 * 见 .github/workflows/linux-integration.yml docling-native job），该值原样
 * 透传——CI 显式配置不得被镜像缺省覆盖。守卫只认 undefined，不做其他推断。
 */

export const HF_MIRROR_ENDPOINT = "https://hf-mirror.com";

export function resolveDefaultHfEndpoint(value: string | undefined): string {
  return value ?? HF_MIRROR_ENDPOINT;
}
