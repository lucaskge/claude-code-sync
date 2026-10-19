# Claude Code Sync

Extensão do VS Code que faz backup, restore e sincronização bi-direcional das conversas do Claude Code
(`~/.claude/projects` / `%USERPROFILE%\.claude\projects`) usando um repositório GitHub **privado**. Não precisa do Git CLI.

- Continue no notebook a conversa que você começou no desktop.
- Merge **sem perdas**: quando a mesma conversa avança em duas máquinas, as duas versões são unidas evento a evento.
- Login pelo GitHub embutido no VS Code: **não há token para criar nem guardar**.

> Projeto independente e não oficial, sem vínculo com a Anthropic. "Claude" e "Claude Code" são marcas da Anthropic.

> ⚠️ **Suas conversas com o Claude podem conter código, senhas e chaves de API.** Elas são enviadas ao GitHub sem
> criptografia adicional, por isso o repositório de backup precisa ser **privado** e **só seu**. Leia a seção
> [Segurança](#segurança) antes de usar.

---

## Instalação

### Pelo arquivo `.vsix`

1. Baixe o `claude-code-sync-<versão>.vsix` na página de [**Releases**](https://github.com/lucaskge/claude-code-sync/releases), ou gere o arquivo você mesmo (veja [Gerar o `.vsix`](#gerar-o-vsix)).
2. Instale de um destes jeitos:
   - No VS Code: aba **Extensões** (`Ctrl+Shift+X`) → menu `⋯` → **Install from VSIX...** → escolha o arquivo.
   - No terminal:
     ```bash
     code --install-extension claude-code-sync-0.2.2.vsix
     ```
3. O ícone **Claude Sync** aparece na barra lateral esquerda.

Requisito: VS Code 1.85 ou mais novo.

### Atualizar

Instale o `.vsix` novo por cima do antigo, do mesmo jeito. As configurações e a conexão com o GitHub são mantidas.

---

## Configuração

> 📘 **Primeira vez?** O [Guia de configuração](docs/GUIA-CONFIGURACAO.md) explica tudo passo a passo, incluindo o que aparece em cada tela e os problemas mais comuns.

1. Clique no ícone **Claude Sync** na barra lateral → **Entrar com GitHub**. Também dá para usar `Ctrl+Shift+P` → **Claude Sync: Configure GitHub Credentials**.
2. Escolha **Entrar com GitHub (recomendado)** e autorize no navegador.
3. Confirme o nome do repositório de backup (sugestão: `seu-usuario/claude-code-backup`). Se ele não existir, a extensão o cria como **privado**.
4. **Antes da primeira sincronização, faça uma cópia das suas conversas:**
   ```bash
   cp -r ~/.claude/projects ~/claude-projects-backup
   ```
5. Clique em **🔄 Sync**.

Numa máquina nova, repita os passos 1 a 3 com a **mesma conta** e o **mesmo repositório**.

### Configurações

| Configuração | Padrão | Descrição |
|---|---|---|
| `claudeSync.githubRepoUrl` | — | Repositório de backup (`usuario/repo`, `https://github.com/usuario/repo` ou `git@github.com:usuario/repo.git`) |
| `claudeSync.githubToken` | — | Opcional: token manual em texto puro. Prefira *Entrar com GitHub* ou o token pelo comando de configuração, que fica no cofre do VS Code |
| `claudeSync.autoSync` | `false` | Sincronização automática em segundo plano |
| `claudeSync.autoSyncInterval` | `30` | Intervalo em minutos |
| `claudeSync.syncOnStartup` | `true` | Sincroniza ao abrir o VS Code (se o auto-sync estiver ligado) |

Todas valem **apenas nas configurações de usuário**. Valores colocados no `.vscode/settings.json` de um projeto são ignorados (o motivo está em [Segurança](#segurança)).

---

## Uso

### Interface

- Barra lateral **Claude Sync** com duas seções:
  - **Projetos Locais**
  - **Sincronização Remota (GitHub)**

  O ícone de cada conversa indica o status: sincronizada, só local, só remota ou diferente. Os botões ⬆️ Push, ⬇️ Pull e 🔄 Sync aparecem no título das seções e em cada item. Dá para selecionar vários itens com Ctrl/Shift.
- Barra de status: `Claude Syncing...` durante a sincronização e `Claude Synced` ao terminar. Clique para sincronizar.

### Comandos (`Ctrl+Shift+P` → "Claude Sync")

| Comando | O que faz |
|---|---|
| Configure GitHub Credentials | Conecta a conta do GitHub e escolhe o repositório |
| Full Synchronization (Push + Pull) | Sincroniza tudo nos dois sentidos |
| Push Local Sessions to GitHub | Envia (tudo, projeto atual, projetos ou conversas escolhidos) |
| Pull Remote Sessions from GitHub | Baixa (mesmas opções) |
| Select Specific Sessions to Sync | Escolhe conversas específicas |
| Change Backup Repository | Troca o repositório; o backup antigo não é apagado |
| Switch GitHub Account | Troca a conta do GitHub |
| Sign Out (Disconnect from GitHub) | Desconecta; nada é apagado |
| Toggle Auto-Sync | Liga ou desliga a sincronização automática |
| Show Log | Mostra os detalhes de cada sincronização |

### Como os projetos são identificados

A pasta local do Claude Code depende do caminho (`/home/usuario/projetoA` → `-home-usuario-projetoA`), e por isso não serve como chave entre máquinas. A chave remota é:

1. a **URL do remote Git** (`origin`) do projeto, por exemplo `git@github.com:acme/projetoA.git` → `repos/acme-projetoa/`;
2. sem remote Git: `local-<nome-da-pasta>`;
3. uma associação manual, feita quando você escolhe a pasta de um projeto remoto que ainda não existe na máquina.

Quando um projeto existe no backup mas não nesta máquina, a extensão **pergunta** onde fica a pasta dele. Se o mesmo caminho existir em outra máquina e também nesta, ele aparece como sugestão, mas só é usado se você confirmar. Por isso, no auto-sync, um projeto novo vindo de outra máquina só é baixado depois de uma sincronização manual em que você escolhe a pasta.

### Merge sem perdas

| Situação | Push | Pull | Sync |
|---|---|---|---|
| Conversa só no local | envia | mantém | envia |
| Conversa só no GitHub | — | baixa | baixa |
| Local contém tudo do remoto e mais | envia | mantém | envia |
| Remoto contém tudo do local e mais | **não sobrescreve** (avisa) | atualiza o local | atualiza o local |
| Os dois lados têm eventos exclusivos | envia a união | `.bak` + grava a união | `.bak` + união nos dois lados |

- A comparação é feita **linha a linha (evento a evento)**: nenhuma linha de nenhum dos lados é descartada. Na divergência, as linhas são intercaladas por `timestamp`.
- Antes de substituir um arquivo local, a extensão grava `<sessão>.jsonl.<data>.bak` na mesma pasta. O Claude Code ignora esses arquivos.
- Conversas modificadas nos últimos 10 segundos (em uso) nunca são sobrescritas. A atualização fica para a próxima sincronização.
- A gravação local é atômica e é cancelada se o arquivo mudar durante a sincronização.
- No remoto, cada sincronização vira **um commit**, e o histórico do Git guarda todas as versões anteriores. Se outra máquina enviar algo no meio, a sincronização relê o remoto e mescla de novo.
- Também são sincronizados os arquivos de `<sessão>/` (`subagents/`, `tool-results/`).
- **Arquivos grandes** (acima de 20 MB, comuns em conversas com imagens coladas) vão comprimidos e divididos em partes de até 20 MB (`<arquivo>.chunks/manifest.json` + `part-NNN.gz`), porque a API do GitHub recusa uploads grandes. Na outra máquina, o arquivo é remontado e conferido byte a byte. Na interface ele aparece como um arquivo só.
- Se o GitHub recusar algum arquivo, os demais são enviados normalmente e o problema aparece nos avisos (*Show Log*).

---

## Segurança

### O que fica onde

| Dado | Onde fica |
|---|---|
| Suas conversas | Na sua máquina (`~/.claude/projects`) e no repositório de backup do GitHub, **sem criptografia adicional** |
| Login do GitHub | Gerenciado pelo próprio VS Code; a extensão não grava nada |
| Token manual (PAT), se usado pelo comando | No cofre seguro do VS Code (`SecretStorage`), nunca no `settings.json` |
| Requisições de rede | Somente para `https://api.github.com`. Nenhum outro servidor recebe dados |

O token nunca é gravado no log.

### Proteções da extensão

- **Repositório público é bloqueado.** A cada envio, a extensão confere se o repositório ainda é privado. Se ele tiver sido tornado público (por engano, ou por outra pessoa de uma organização), o envio é cancelado e nada sai da máquina. Usar um repositório público só é possível com confirmação explícita no comando de configuração.
- **Projetos abertos não controlam a extensão.** As configurações `claudeSync.*` só valem nas configurações de usuário. Sem isso, um repositório malicioso poderia trazer um `.vscode/settings.json` que apontasse o backup para outro repositório e ligasse o auto-sync, enviando todas as suas conversas para lá assim que você abrisse o projeto.
- **O token manual não vai para a nuvem do VS Code.** O campo `claudeSync.githubToken` é ignorado pelo Settings Sync.
- **Dados vindos do GitHub são tratados como não confiáveis:**
  - caminhos com `..`, barras invertidas ou caracteres especiais são recusados, e nada é gravado fora de `~/.claude/projects`;
  - nomes de projeto e de conversa só são aceitos com letras, números, `.`, `_` e `-`;
  - arquivos comprimidos não podem crescer além do tamanho declarado (proteção contra "bombas" de descompressão), e arquivos acima de 1 GB não são baixados;
  - o `metadata.json` remoto é validado campo a campo antes de ser usado;
  - caminhos de outras máquinas gravados no backup nunca decidem sozinhos onde gravar arquivos; no máximo aparecem como sugestão.
- **O nome do repositório é validado** pelas regras do GitHub, o que impede que um valor como `../..` desvie as requisições para outro endpoint da API com o seu token.
- **Credenciais em URLs de remote Git** (`https://usuario:token@...`) são removidas antes de irem para o `metadata.json`.

### Riscos que você precisa conhecer

Estes riscos vêm da própria ideia de sincronizar pelo GitHub e não podem ser eliminados pelo código:

1. **As conversas podem conter segredos.** Chaves coladas no chat e conteúdo de `.env` lido por ferramentas do Claude ficam gravados nos `.jsonl` e vão para o backup.
   - Mantenha o repositório **privado** e não adicione colaboradores.
   - Se um segredo foi parar numa conversa, troque o segredo. Apagar o arquivo não basta, porque ele continua no histórico de commits.
2. **Quem tem escrita no repositório consegue injetar conversas nas suas máquinas.** Uma conversa falsa baixada pelo Pull pode conter instruções que o Claude seguiria ao retomá-la. Não compartilhe o repositório de backup com ninguém.
3. **O login do VS Code pede a permissão `repo`**, que vale para **todos** os repositórios da sua conta, não só para o backup. É uma limitação do login do GitHub no VS Code, e é a mesma permissão usada por extensões como GitHub Pull Requests. Para limitar o acesso a um único repositório, use um token *fine-grained* (veja o [apêndice do guia](docs/GUIA-CONFIGURACAO.md#apêndice--usar-um-token-manual-pat)).
4. **Uma conta do GitHub comprometida expõe o backup.** Ative a autenticação em dois fatores na sua conta.

### Revogar o acesso

- Login do VS Code: https://github.com/settings/applications → **Authorized OAuth Apps** → **Visual Studio Code** → **Revoke**.
- Token manual: https://github.com/settings/personal-access-tokens → o token → **Delete**.
- Na extensão: **Claude Sync: Sign Out** desconecta e para a sincronização, sem apagar nada.

### Reportar uma vulnerabilidade

Não abra uma issue pública. Veja como reportar de forma privada na [política de segurança](SECURITY.md).

---

## Desenvolvimento

### Requisitos

- Node.js 20 ou mais novo
- VS Code 1.85 ou mais novo

### Comandos

```bash
npm install        # instala as dependências
npm run compile    # compila o TypeScript para out/
npm run watch      # recompila a cada alteração
npm test           # testes do merge, do motor (duas máquinas simuladas com um GitHub falso) e de segurança
```

Para depurar, abra a pasta no VS Code e pressione **F5** (*Run Extension*). Uma nova janela do VS Code abre com a extensão carregada.

### Estrutura

| Caminho | Conteúdo |
|---|---|
| `src/extension.ts` | Ativação, comandos, login e interface |
| `src/services/syncEngine.ts` | Motor de sincronização e merge dos `.jsonl` |
| `src/services/githubService.ts` | Cliente da API REST do GitHub |
| `src/services/claudeStorageService.ts` | Leitura e gravação em `~/.claude/projects` |
| `src/services/chunkedStorage.ts` | Compressão e divisão de arquivos grandes |
| `src/views/claudeTreeDataProvider.ts` | Árvores da barra lateral |
| `src/test/` | Testes (`node --test`) |

### Gerar o `.vsix`

1. Se mudou algo para os usuários, aumente a versão (atualiza o `package.json` e o `package-lock.json`):
   ```bash
   npm version patch --no-git-tag-version   # 0.2.2 → 0.2.3 (use minor ou major para mudanças maiores)
   ```
2. Rode os testes e gere o pacote:
   ```bash
   npm test
   npm run package
   ```
   O `npm run package` compila o projeto e gera `claude-code-sync-<versão>.vsix` na raiz.
3. Confira a lista de arquivos que o comando imprime. Ela deve ter só `package.json`, `readme.md`, `docs/`, `media/` e `out/` (sem testes nem `.map`). O que fica de fora é definido no `.vscodeignore`.
4. Para distribuir, anexe o `.vsix` a uma **Release** no GitHub. Não faça commit do `.vsix`: ele já está no `.gitignore`.

---

## Contribuir

Contribuições são bem-vindas! Veja o [guia de contribuição](CONTRIBUTING.md).

## Licença

[MIT](LICENSE) © lucaskge
