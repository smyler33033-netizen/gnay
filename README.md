# Gnay local

Este projeto usa um servidor local para login pelo Discord e para salvar perfis e bios. Ele não depende de um provedor de pagamentos.

## Configurar o login Discord

1. No Discord Developer Portal, crie uma aplicação e abra **OAuth2**.
2. Adicione este Redirect URI, exatamente como está:
   `http://localhost:8765/auth/discord/callback`
3. Copie `.env.example` para `.env` e preencha Client ID e Client Secret. O arquivo fica local e é ignorado pelo Git:

   ```env
   DISCORD_CLIENT_ID=seu_client_id
   DISCORD_CLIENT_SECRET=seu_client_secret
   DISCORD_REDIRECT_URI=http://localhost:8765/auth/discord/callback
   ```

   Não compartilhe o Client Secret. O arquivo `.env` é ignorado pelo Git.

## Executar

Abra um terminal nesta pasta e rode:

```powershell
node server.js
```

Depois acesse <http://localhost:8765>. Para parar o servidor, pressione `Ctrl+C`.

As contas e perfis ficam em `data/store.json`; uploads locais ficam em `uploads/`.

## Preparar backend de teste no Render

O arquivo `render.yaml` configura o servidor Node como serviço gratuito para testes. No Render, crie um **Blueprint** a partir de um repositório contendo este projeto e preencha `DISCORD_CLIENT_ID` e `DISCORD_CLIENT_SECRET` como variáveis secretas. A aplicação Discord deve ter este Redirect URI:

`https://gnay.netlify.app/auth/discord/callback`

O plano gratuito não mantém arquivos locais após reinícios; não use para guardar dados importantes. Depois que o serviço iniciar, configure o Netlify para encaminhar `/auth/*`, `/api/*` e `/uploads/*` para a URL `onrender.com` do backend. Sem esses encaminhamentos, o login e as APIs continuarão retornando 404 no domínio Netlify.

O arquivo `netlify.toml` configura esses encaminhamentos para `https://gnay-api.onrender.com`. Inclua-o no deploy do Netlify para ativar o login e as APIs no domínio publicado.

Os contadores públicos e as estatísticas do painel são calculados a partir das contas, arquivos enviados e eventos reais de visualização e clique armazenados pelo backend. Dados de país são registrados quando o Netlify encaminha o código de país da visita. Como o serviço gratuito do Render usa armazenamento temporário, esses dados podem ser perdidos quando o serviço reinicia.

Integrações como pagamentos, MFA, templates e recursos administrativos continuam dependendo de serviços adicionais.

## Cartão e atividades do Discord

O perfil usa o ID da conta autenticada para exibir o cartão do Discord. Para exibir presença e atividades ao vivo, a conta também precisa entrar no [servidor Lanyard](https://discord.gg/lanyard) e permitir que ele compartilhe a presença. O servidor local consulta a API pública do Lanyard; se a conta não estiver sendo monitorada, o perfil informa como ativar o recurso. A decoração do avatar é lida dos dados de identificação do Discord no próximo login.
