# Política de segurança

O Claude Code Sync lida com dados sensíveis: o histórico de conversas do Claude Code, que pode conter código, senhas e chaves, e o acesso à conta do GitHub. Relatos de vulnerabilidade são levados a sério.

## Versões com suporte

Só a versão mais recente recebe correções de segurança. Antes de reportar, confira se o problema acontece nela.

| Versão | Suporte |
|---|---|
| A mais recente (veja [Releases](https://github.com/lucaskge/claude-code-sync/releases)) | ✅ |
| Anteriores | ❌ |

## Como reportar

**Não abra uma issue pública.** Use o canal privado do GitHub:

1. Abra a aba [**Security and quality**](https://github.com/lucaskge/claude-code-sync/security) do repositório.
2. Clique em **Report a vulnerability**.
3. Descreva:
   - o que acontece e qual é o impacto (por exemplo: vazamento de conversas, acesso ao token, gravação de arquivos fora de `~/.claude/projects`);
   - os passos para reproduzir;
   - a versão da extensão, do VS Code e o sistema operacional.

**Nunca envie conversas reais, tokens ou chaves**, nem mesmo no relato privado. Use dados inventados para demonstrar o problema.

## O que esperar

- Confirmação de recebimento em até **7 dias**.
- Se a falha for confirmada, a correção é publicada numa nova versão e o problema é divulgado num *security advisory* depois que a correção estiver disponível. Quem reportou recebe o crédito, se quiser.
- Se o relato não for considerado uma vulnerabilidade, você recebe uma explicação do motivo.

Este é um projeto mantido por uma pessoa nas horas vagas, então os prazos são uma meta, não uma garantia.

## Escopo

Estão no escopo problemas no código desta extensão, por exemplo:

- envio de conversas para um repositório diferente do configurado pelo usuário;
- exposição do token do GitHub (logs, arquivos, requisições para outros servidores);
- gravação ou leitura de arquivos fora de `~/.claude/projects` a partir de dados do repositório remoto;
- falhas que permitam a um projeto aberto no VS Code controlar a extensão.

Estão fora do escopo:

- os riscos de design já documentados na seção [Segurança do README](README.md#segurança), como a permissão `repo` do login do GitHub ou a ausência de criptografia adicional no backup;
- vulnerabilidades no VS Code, no GitHub ou no Claude Code em si. Reporte essas aos respectivos responsáveis.
