# Como contribuir

Obrigado pelo interesse! Contribuições são bem-vindas: correções, melhorias, testes e documentação.

## Antes de começar

- **Bugs e ideias:** abra uma *issue* descrevendo o problema ou a proposta. Para mudanças grandes, converse na issue antes de escrever o código.
- **Vulnerabilidades de segurança:** **não** abra uma issue pública. Siga a [política de segurança](SECURITY.md).
- **Nunca cole conversas reais do Claude Code** em issues, PRs ou testes. Elas podem conter código, senhas e chaves. Use dados inventados.

## Preparar o ambiente

Requisitos: Node.js 22 ou mais novo e VS Code 1.85 ou mais novo.

```bash
git clone https://github.com/lucaskge/claude-code-sync.git
cd claude-code-sync
npm install
npm test
```

Para testar a extensão de verdade, abra a pasta no VS Code e pressione **F5**. Uma nova janela abre com a extensão carregada.

> 💡 Durante os testes manuais, use um **repositório de backup só para testes** e, se possível, aponte o Claude Code
> para uma pasta separada com a variável `CLAUDE_CONFIG_DIR`, para não mexer nas suas conversas reais.

## Enviar uma alteração

1. Faça um *fork* do repositório e crie um branch: `git checkout -b minha-melhoria`.
2. Faça a alteração. Siga o estilo do código ao redor: TypeScript estrito, comentários e mensagens em português.
3. **Adicione ou ajuste testes** em `src/test/` quando mudar comportamento, principalmente no merge e na sincronização.
4. Rode `npm test` e confira que tudo passa.
5. Abra um *Pull Request* explicando **o que** mudou e **por quê**. Os testes rodam automaticamente no PR.

## Regras que não podem ser quebradas

A extensão mexe no histórico de conversas das pessoas. Qualquer mudança precisa manter estas garantias:

- **Nenhuma conversa local é apagada ou truncada.** Na dúvida, mantenha os dois lados e gere um `.bak`.
- **Dados vindos do GitHub são não confiáveis:** valide caminhos, nomes e tamanhos antes de usá-los. Nada pode ser gravado fora de `~/.claude/projects`.
- **Tokens nunca vão para logs**, mensagens de erro ou arquivos.
- **Nenhuma requisição de rede** além de `https://api.github.com`.
- As configurações `claudeSync.*` continuam restritas às configurações de usuário (`scope` `application`/`machine` no `package.json`).

## Licença

Ao contribuir, você concorda que sua contribuição será distribuída sob a [licença MIT](LICENSE) do projeto.
