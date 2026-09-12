-- 0003：用户级 LLM 提取配置（每个用户自己的模型/密钥，管理后台不统一配置）
ALTER TABLE users ADD COLUMN llm_api_url TEXT;
ALTER TABLE users ADD COLUMN llm_api_key_enc TEXT;
ALTER TABLE users ADD COLUMN llm_model TEXT;
