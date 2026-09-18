import type { ProviderAgent, ProviderAgentConfig } from "./provider-config.js";

/**
 * A provider the settings page can add in one step: the endpoints are filled in
 * and only the key is missing. `agents[*].models` are *seed* candidates — the
 * page still pulls the live list from the provider once it has a key, and the
 * user ticks from the union. A seed is what is shown when a provider has no
 * model-listing endpoint (most Anthropic-compatible ones do not).
 */
export interface ProviderPreset {
  id: string;
  name: string;
  docsUrl?: string;
  /** `cn` / `global` when the vendor runs separate regional endpoints. */
  region?: string;
  agents: Partial<Record<ProviderAgent, ProviderAgentConfig>>;
}

/**
 * Taken from Cindy's public model catalog (`model-access-server/catalog/providers.json`,
 * catalog version 2, revision of 2026-08-06): its `presets` list, with the
 * Claude Code runtime mapped to the `claude-code` agent (Anthropic-compatible
 * endpoint) and the Codex runtime's OpenAI-compatible endpoint mapped to the
 * in-house `vgent` agent. Refresh it from that file rather than editing by hand.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    "id": "openrouter",
    "name": "OpenRouter",
    "docsUrl": "https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration",
    "region": "global",
    "agents": {
      "vgent": {
        "baseURL": "https://openrouter.ai/api/v1",
        "protocol": "openai-compatible",
        "models": [
          {
            "id": "z-ai/glm-5.2",
            "label": "GLM-5.2"
          },
          {
            "id": "moonshotai/kimi-k2.6",
            "label": "Kimi K2.6"
          }
        ]
      },
      "claude-code": {
        "baseURL": "https://openrouter.ai/api",
        "protocol": "anthropic",
        "models": [
          {
            "id": "z-ai/glm-5.2",
            "label": "GLM-5.2"
          },
          {
            "id": "moonshotai/kimi-k2.6",
            "label": "Kimi K2.6"
          },
          {
            "id": "deepseek/deepseek-v4-pro",
            "label": "DeepSeek V4 Pro",
            "contextWindow": 1000000
          }
        ]
      }
    }
  },
  {
    "id": "deepseek",
    "name": "DeepSeek",
    "docsUrl": "https://api-docs.deepseek.com/guides/anthropic_api",
    "agents": {
      "vgent": {
        "baseURL": "https://api.deepseek.com",
        "protocol": "openai-compatible",
        "models": [
          {
            "id": "deepseek-v4-flash",
            "label": "DeepSeek V4 Flash",
            "contextWindow": 1000000
          },
          {
            "id": "deepseek-v4-pro",
            "label": "DeepSeek V4 Pro",
            "contextWindow": 1000000
          }
        ]
      },
      "claude-code": {
        "baseURL": "https://api.deepseek.com/anthropic",
        "protocol": "anthropic",
        "models": [
          {
            "id": "deepseek-v4-flash",
            "label": "DeepSeek V4 Flash",
            "contextWindow": 1000000
          },
          {
            "id": "deepseek-v4-pro",
            "label": "DeepSeek V4 Pro",
            "contextWindow": 1000000
          }
        ]
      }
    }
  },
  {
    "id": "zhipu-glm-cn",
    "name": "智谱 GLM（中国大陆）",
    "docsUrl": "https://docs.bigmodel.cn/cn/guide/develop/claude",
    "region": "cn",
    "agents": {
      "vgent": {
        "baseURL": "https://open.bigmodel.cn/api/paas/v4",
        "protocol": "openai-compatible",
        "models": [
          {
            "id": "glm-5.2",
            "label": "GLM-5.2"
          },
          {
            "id": "glm-5.1",
            "label": "GLM-5.1"
          }
        ]
      },
      "claude-code": {
        "baseURL": "https://open.bigmodel.cn/api/anthropic",
        "protocol": "anthropic",
        "models": [
          {
            "id": "glm-5.2",
            "label": "GLM-5.2"
          },
          {
            "id": "glm-5.1",
            "label": "GLM-5.1"
          }
        ]
      }
    }
  },
  {
    "id": "zhipu-glm-global",
    "name": "Z.ai GLM (Global)",
    "docsUrl": "https://docs.z.ai/devpack/tool/claude",
    "region": "global",
    "agents": {
      "vgent": {
        "baseURL": "https://api.z.ai/api/paas/v4",
        "protocol": "openai-compatible",
        "models": [
          {
            "id": "glm-5.2",
            "label": "GLM-5.2"
          },
          {
            "id": "glm-5.1",
            "label": "GLM-5.1"
          }
        ]
      },
      "claude-code": {
        "baseURL": "https://api.z.ai/api/anthropic",
        "protocol": "anthropic",
        "models": [
          {
            "id": "glm-5.2",
            "label": "GLM-5.2"
          },
          {
            "id": "glm-5.1",
            "label": "GLM-5.1"
          }
        ]
      }
    }
  },
  {
    "id": "moonshot-kimi-cn",
    "name": "Kimi (Moonshot 中国大陆)",
    "docsUrl": "https://platform.moonshot.cn/docs/guide/agent-support",
    "region": "cn",
    "agents": {
      "vgent": {
        "baseURL": "https://api.moonshot.cn/v1",
        "protocol": "openai-compatible",
        "models": [
          {
            "id": "kimi-k3",
            "label": "Kimi K3",
            "contextWindow": 1048576
          },
          {
            "id": "kimi-k2.7-code",
            "label": "Kimi K2.7 Code",
            "contextWindow": 262144
          },
          {
            "id": "kimi-k2.6",
            "label": "Kimi K2.6",
            "contextWindow": 262144
          }
        ]
      },
      "claude-code": {
        "baseURL": "https://api.moonshot.cn/anthropic",
        "protocol": "anthropic",
        "models": [
          {
            "id": "kimi-k3",
            "label": "Kimi K3",
            "contextWindow": 1048576
          },
          {
            "id": "kimi-k2.7-code",
            "label": "Kimi K2.7 Code",
            "contextWindow": 262144
          },
          {
            "id": "kimi-k2.6",
            "label": "Kimi K2.6",
            "contextWindow": 262144
          }
        ]
      }
    }
  },
  {
    "id": "moonshot-kimi-global",
    "name": "Kimi (Moonshot Global)",
    "docsUrl": "https://platform.moonshot.ai/docs/guide/agent-support",
    "region": "global",
    "agents": {
      "vgent": {
        "baseURL": "https://api.moonshot.ai/v1",
        "protocol": "openai-compatible",
        "models": [
          {
            "id": "kimi-k3",
            "label": "Kimi K3",
            "contextWindow": 1048576
          },
          {
            "id": "kimi-k2.7-code",
            "label": "Kimi K2.7 Code",
            "contextWindow": 262144
          },
          {
            "id": "kimi-k2.6",
            "label": "Kimi K2.6",
            "contextWindow": 262144
          }
        ]
      },
      "claude-code": {
        "baseURL": "https://api.moonshot.ai/anthropic",
        "protocol": "anthropic",
        "models": [
          {
            "id": "kimi-k3",
            "label": "Kimi K3",
            "contextWindow": 1048576
          },
          {
            "id": "kimi-k2.7-code",
            "label": "Kimi K2.7 Code",
            "contextWindow": 262144
          },
          {
            "id": "kimi-k2.6",
            "label": "Kimi K2.6",
            "contextWindow": 262144
          }
        ]
      }
    }
  },
  {
    "id": "moonshot-kimi-code",
    "name": "Kimi Code（编程计划包月）",
    "docsUrl": "https://www.kimi.com/zh-cn/help/kimi-code/third-party-agents",
    "agents": {
      "vgent": {
        "baseURL": "https://api.kimi.com/coding/v1",
        "protocol": "openai-compatible",
        "models": [
          {
            "id": "kimi-for-coding",
            "label": "Kimi for Coding",
            "contextWindow": 262144
          },
          {
            "id": "kimi-for-coding-highspeed",
            "label": "Kimi for Coding 高速版",
            "contextWindow": 262144
          },
          {
            "id": "k3",
            "label": "Kimi K3",
            "contextWindow": 262144
          }
        ]
      },
      "claude-code": {
        "baseURL": "https://api.kimi.com/coding",
        "protocol": "anthropic",
        "models": [
          {
            "id": "kimi-for-coding",
            "label": "Kimi for Coding",
            "contextWindow": 262144
          },
          {
            "id": "kimi-for-coding-highspeed",
            "label": "Kimi for Coding 高速版",
            "contextWindow": 262144
          },
          {
            "id": "k3",
            "label": "Kimi K3",
            "contextWindow": 262144
          }
        ]
      }
    }
  },
  {
    "id": "minimax-cn",
    "name": "MiniMax（中国大陆）",
    "docsUrl": "https://platform.minimaxi.com/docs/api-reference/responses-create",
    "region": "cn",
    "agents": {
      "vgent": {
        "baseURL": "https://api.minimaxi.com/v1",
        "protocol": "openai-compatible",
        "models": [
          {
            "id": "MiniMax-M3",
            "label": "MiniMax M3",
            "contextWindow": 1000000
          },
          {
            "id": "MiniMax-M2.5",
            "label": "MiniMax M2.5"
          }
        ]
      },
      "claude-code": {
        "baseURL": "https://api.minimaxi.com/anthropic",
        "protocol": "anthropic",
        "models": [
          {
            "id": "MiniMax-M3",
            "label": "MiniMax M3"
          },
          {
            "id": "MiniMax-M2.5",
            "label": "MiniMax M2.5"
          }
        ]
      }
    }
  },
  {
    "id": "minimax-global",
    "name": "MiniMax (Global)",
    "docsUrl": "https://platform.minimax.io/docs/api-reference/responses-create",
    "region": "global",
    "agents": {
      "vgent": {
        "baseURL": "https://api.minimax.io/v1",
        "protocol": "openai-compatible",
        "models": [
          {
            "id": "MiniMax-M3",
            "label": "MiniMax M3",
            "contextWindow": 1000000
          },
          {
            "id": "MiniMax-M2.5",
            "label": "MiniMax M2.5"
          }
        ]
      },
      "claude-code": {
        "baseURL": "https://api.minimax.io/anthropic",
        "protocol": "anthropic",
        "models": [
          {
            "id": "MiniMax-M3",
            "label": "MiniMax M3"
          },
          {
            "id": "MiniMax-M2.5",
            "label": "MiniMax M2.5"
          }
        ]
      }
    }
  },
  {
    "id": "aliyun-bailian-coding",
    "name": "阿里云百炼 Coding Plan（包月）",
    "docsUrl": "https://help.aliyun.com/zh/model-studio/coding-plan",
    "region": "cn",
    "agents": {
      "vgent": {
        "baseURL": "https://coding.dashscope.aliyuncs.com/v1",
        "protocol": "openai-compatible",
        "models": [
          {
            "id": "qwen3.7-plus",
            "label": "Qwen3.7 Plus"
          },
          {
            "id": "qwen3-coder-next",
            "label": "Qwen3 Coder Next"
          },
          {
            "id": "qwen3-coder-plus",
            "label": "Qwen3 Coder Plus"
          }
        ]
      },
      "claude-code": {
        "baseURL": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
        "protocol": "anthropic",
        "models": [
          {
            "id": "qwen3.7-plus",
            "label": "Qwen3.7 Plus"
          },
          {
            "id": "qwen3-coder-next",
            "label": "Qwen3 Coder Next"
          },
          {
            "id": "qwen3-coder-plus",
            "label": "Qwen3 Coder Plus"
          }
        ]
      }
    }
  }
];

export function findProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}
