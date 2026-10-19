# Guia de configuração — Claude Code Sync

Este guia leva do zero até a primeira sincronização. Leva uns 5 minutos e **não exige criar nem guardar token nenhum**.

## Como a extensão acessa o GitHub

A extensão guarda as suas conversas do Claude Code num **repositório privado no seu GitHub**, e para isso precisa da sua autorização.

O jeito recomendado é o **login do GitHub embutido no VS Code**, o mesmo usado pela sincronização de configurações e pela extensão de Pull Requests:

- você clica em **Entrar com GitHub**, o navegador abre e você autoriza;
- o VS Code guarda e renova o acesso sozinho;
- numa máquina nova, **daqui a 3 meses ou 3 anos**, você só faz o login de novo. Não há nada para anotar ou guardar.

> Também existe a opção de usar um token manual (PAT), descrita no [apêndice](#apêndice--usar-um-token-manual-pat). Ela só vale a pena se você quiser um acesso restrito a um único repositório.

## Passo 1 — Instalar a extensão

No VS Code: aba **Extensões** (`Ctrl+Shift+X`) → menu `⋯` → **Install from VSIX...** → escolha o arquivo `claude-code-sync-<versão>.vsix`.

Ou no terminal:

```bash
code --install-extension claude-code-sync-0.2.2.vsix
```

## Passo 2 — Entrar com GitHub

1. No VS Code, clique no ícone **Claude Sync** na barra lateral esquerda e depois em **Entrar com GitHub**. Também dá para usar `Ctrl+Shift+P` → **Claude Sync: Configure GitHub Credentials**.
2. Escolha **Entrar com GitHub (recomendado)**.
3. O VS Code pergunta se a extensão pode entrar com o GitHub. Clique em **Allow** (Permitir).
4. O navegador abre na página do GitHub. Confira a conta e clique em **Authorize** (Autorizar).
   - Se você já estiver logado no GitHub dentro do VS Code, esse passo pode nem aparecer.
5. De volta ao VS Code, confirme o **nome do repositório de backup**. A extensão já sugere `seu-usuario/claude-code-backup`; é só teclar Enter.
6. Se o repositório ainda não existir, a extensão pergunta se pode **criá-lo como privado**. Clique em **Criar repositório privado**.
7. Aparece **"Claude Sync configurado: seu-usuario → seu-usuario/claude-code-backup"**.

## Passo 3 — Primeira sincronização (com segurança)

1. **Faça uma cópia das suas conversas** antes do primeiro uso:
   ```bash
   cp -r ~/.claude/projects ~/claude-projects-backup
   ```
   No Windows: copie `%USERPROFILE%\.claude\projects` para outra pasta.
2. Na barra lateral **Claude Sync**, clique no botão **⬆️ Push** e escolha **Projeto atual**.
3. Abra o repositório no GitHub e confira se apareceu `repos/<nome-do-projeto>/`, com os arquivos `.jsonl` e o `metadata.json`.
4. Se estiver tudo certo, use **🔄 Sync** para sincronizar tudo.

## Numa máquina nova (agora ou daqui a meses)

1. Instale a extensão (passo 1).
2. Faça o **passo 2** com a **mesma conta do GitHub**. No nome do repositório, use o **mesmo** da primeira máquina, por exemplo `seu-usuario/claude-code-backup`.
   - Se a **sincronização de configurações do VS Code** (Settings Sync) estiver ligada, o nome do repositório já vem preenchido.
3. Clique em **🔄 Sync**.
4. Para cada projeto que existir no backup, mas ainda não nesta máquina, a extensão pergunta **onde fica a pasta desse projeto**. Escolha a pasta (por exemplo, onde você clonou o repositório) ou **Ignorar**. Você pode sincronizar esse projeto depois, quando cloná-lo.

**Não é preciso criar, copiar nem guardar nenhum token.**

## Sincronização automática (opcional)

Em *Configurações* (`Ctrl+,`), pesquise por `Claude Sync`:

- **Auto Sync:** liga a sincronização em segundo plano.
- **Auto Sync Interval:** de quantos em quantos minutos sincronizar (padrão: 30).
- **Sync On Startup:** sincroniza ao abrir o VS Code.

Também dá para ligar e desligar pelo comando **Claude Sync: Toggle Auto-Sync**. Com o auto-sync ligado, o andamento aparece só na barra de status, embaixo à esquerda: `Claude Syncing...` e depois `Claude Synced`.

## Problemas comuns

| Mensagem | Causa | Solução |
|---|---|---|
| **Você não está conectado ao GitHub.** | Você saiu da conta do GitHub no VS Code, ou ainda não fez o passo 2. | Faça o passo 2 de novo. |
| **Repositório ... não encontrado ou sem acesso.** | O nome do repositório está diferente do usado na outra máquina, ou está em outra conta. | Use *Change Backup Repository* para corrigir o nome, ou *Switch GitHub Account* para trocar a conta. |
| **Acesso negado pelo GitHub.** | O repositório é de uma **organização** que bloqueia o acesso de aplicativos de terceiros. | Use um repositório na sua conta pessoal, ou peça ao administrador da organização para liberar o "Visual Studio Code". |
| **Limite de requisições da API do GitHub atingido.** | Muitas requisições num curto período. | Aguarde até o horário indicado na mensagem. |
| **Sessão em uso agora pelo Claude Code; atualização local adiada.** | A conversa estava aberta e sendo escrita. Não é um erro. | Ela é atualizada na próxima sincronização. |
| **... não enviado — Sorry, your input was too large to process.** | Versões até a 0.2.0 tentavam enviar arquivos grandes (com imagens coladas) de uma vez, e o GitHub recusava. | Atualize para a 0.2.1 ou mais nova, que divide esses arquivos em partes automaticamente. |
| **O remoto tem eventos mais novos; use Pull ou Sync.** | O Push não sobrescreve o que está no GitHub. | Use **🔄 Sync**. |
| **O repositório ... é PÚBLICO. Envio bloqueado...** | O repositório de backup foi tornado público. Nada foi enviado. | No GitHub, abra o repositório → **Settings** → **Danger Zone** → **Change visibility** → *Private*. Depois sincronize de novo. |
| **Projeto ... não tem pasta local associada nesta máquina** (no log) | Um projeto novo chegou de outra máquina durante o auto-sync. Por segurança, a extensão não escolhe a pasta sozinha. | Rode **🔄 Sync** manualmente uma vez e escolha a pasta do projeto. |
| Uma configuração `claudeSync.*` no `.vscode/settings.json` do projeto não tem efeito | Por segurança, essas configurações só valem nas configurações de usuário. | Defina-as em *Configurações* (`Ctrl+,`) → aba **Usuário**. |

Para ver os detalhes de qualquer sincronização: **Claude Sync: Show Log**.


## Trocar de conta, de repositório ou desconectar

A conta e o repositório em uso aparecem no topo da seção **Sincronização Remota (GitHub)**, por exemplo `seu-usuario → seu-usuario/claude-code-backup`. As opções abaixo ficam no menu **⋯** do título das seções do Claude Sync, ou em `Ctrl+Shift+P`:

| Comando | O que faz |
|---|---|
| **Claude Sync: Change Backup Repository** | Troca só o repositório de backup e mantém a conta. Se o repositório novo não existir, oferece criá-lo como privado. O backup antigo **não é apagado** e continua no GitHub. |
| **Claude Sync: Switch GitHub Account** | Troca a conta do GitHub. Você pode escolher entre as contas já conectadas no VS Code, entrar com outra conta ou usar um token. Em seguida, confirma o repositório de backup, porque a nova conta pode não ter acesso ao anterior. |
| **Claude Sync: Sign Out (Disconnect from GitHub)** | Desconecta o Claude Sync do GitHub, e a sincronização (inclusive a automática) para. **Nada é apagado**: nem as conversas locais, nem o backup. Para voltar, use *Configure GitHub Credentials*. |

**Entrar com outra conta:** ao escolher *Entrar com outra conta do GitHub*, o navegador abre a página de autorização. Se o navegador já estiver logado na conta atual, ele autoriza essa mesma conta. Antes de autorizar, saia dela no github.com, ou copie o link para uma **janela anônima** e entre com a outra conta.

**Sair da conta no VS Code inteiro:** o *Sign Out* desconecta só o Claude Sync. A conta do GitHub continua conectada ao VS Code, porque outros recursos a usam (Settings Sync, Pull Requests, Copilot). Para sair dela também, clique no ícone de **Contas** (o bonequinho, no canto inferior esquerdo do VS Code) → sua conta do GitHub → **Sign Out**.

## Onde ficam os backups `.bak`

Quando a mesma conversa foi continuada em duas máquinas, a extensão junta as duas versões. Antes disso, ela salva a versão local antiga ao lado do original:

```
~/.claude/projects/<projeto>/<id-da-sessão>.jsonl.20261013-151129.bak
```

O Claude Code ignora esses arquivos. Pode apagá-los quando tiver certeza de que a versão mesclada está correta.

## Segurança

O essencial:

- Mantenha o repositório de backup **privado** e **não adicione colaboradores**. Quem tem escrita nele consegue colocar conversas nas suas máquinas.
- Suas conversas podem conter senhas e chaves. Se um segredo foi parar numa conversa, troque o segredo.
- A extensão cria o repositório como privado e **bloqueia o envio** se ele se tornar público.
- O login do VS Code pede a permissão `repo` do GitHub, que vale para **todos** os repositórios da sua conta. Para restringir a um único repositório, use um token (veja o [apêndice](#apêndice--usar-um-token-manual-pat)).
- Ative a autenticação em dois fatores na sua conta do GitHub.
- Para revogar o acesso a qualquer momento: no GitHub, abra https://github.com/settings/applications → **Authorized OAuth Apps** → **Visual Studio Code** → **Revoke**.

Os detalhes, incluindo todas as proteções da extensão, estão na seção [Segurança do README](../README.md#segurança).

---

## Apêndice — usar um token manual (PAT)

Use essa opção só se quiser que a extensão enxergue **apenas** o repositório de backup, e nenhum outro.

> ⚠️ O GitHub mostra o token **uma única vez**. Numa máquina nova, você vai precisar dele de novo ou terá que gerar outro. Se não quiser lidar com isso, use **Entrar com GitHub**.

1. Crie o repositório privado em https://github.com/new. Tokens *fine-grained* não conseguem criar repositórios.
2. Crie o token em https://github.com/settings/personal-access-tokens/new:
   - **Repository access:** *Only select repositories* → o repositório de backup.
   - **Permissions → Repository permissions → Contents:** *Read and write*.
   - Clique em **Generate token** e copie o valor, que começa com `github_pat_...`.
3. No VS Code, execute **Claude Sync: Configure GitHub Credentials**, escolha **Usar um token de acesso (PAT)** e cole o token.

O token fica no cofre seguro do VS Code. Quando ele vencer, gere outro e repita o passo 3.

Se você usa o GitHub CLI, `gh auth token` mostra um token que já funciona. Esse token, porém, dá acesso a todos os repositórios, como o login.
