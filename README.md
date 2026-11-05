# Gnay local

Este projeto usa um servidor local para login pelo Discord e para salvar perfis e bios. Ele não depende de um provedor de pagamentos.

## Configurar o login Discord

1. No Discord Developer Portal, crie uma aplicação e abra **OAuth2**. O login solicita apenas o escopo `identify`. O escopo `identify.premium` é restrito a aplicações aprovadas pelo Discord e não é necessário para entrar.
2. Adicione estes Redirect URIs, exatamente como estão:
   `http://localhost:8765/auth/discord/callback`
   `https://gnay.netlify.app/auth/discord/callback`
3. Copie `.env.example` para `.env` e preencha Client ID e Client Secret. O arquivo fica local e é ignorado pelo Git:

   ```env
   DISCORD_CLIENT_ID=seu_client_id
   DISCORD_CLIENT_SECRET=seu_client_secret
   DISCORD_BOT_TOKEN=token_secreto_do_bot
   DISCORD_REDIRECT_URI=http://localhost:8765/auth/discord/callback
   ```

   `DISCORD_BOT_TOKEN` é necessário apenas para mostrar os cargos do servidor no Chat Geral. Nunca coloque esse token no HTML nem o compartilhe; configure-o como variável secreta no Render e mantenha o bot no servidor oficial.

## Executar

Abra um terminal nesta pasta e rode:

```powershell
node server.js
```

Depois acesse <http://localhost:8765>. Para parar o servidor, pressione `Ctrl+C`.

As contas e perfis ficam em `data/store.json`; uploads locais ficam em `uploads/`.

## Preparar backend de teste no Render

O arquivo `render.yaml` configura o servidor Node como serviço gratuito para testes. No Render, crie um **Blueprint** a partir de um repositório contendo este projeto e preencha `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` e `DISCORD_BOT_TOKEN` como variáveis secretas. A aplicação Discord deve ter este Redirect URI:

`https://gnay.netlify.app/auth/discord/callback`

O plano gratuito não mantém arquivos locais após reinícios; não use para guardar dados importantes. Depois que o serviço iniciar, configure o Netlify para encaminhar `/auth/*`, `/api/*` e `/uploads/*` para a URL `onrender.com` do backend. Sem esses encaminhamentos, o login e as APIs continuarão retornando 404 no domínio Netlify.

O arquivo `netlify.toml` configura esses encaminhamentos para `https://gnay-api.onrender.com`. Inclua-o no deploy do Netlify para ativar o login e as APIs no domínio publicado.

Se o site informar que o Discord não autorizou o login, confira se o fluxo foi concluído com **Autorizar** e se `https://gnay.netlify.app/auth/discord/callback` está cadastrado exatamente como Redirect URI no Discord Developer Portal. O estado de segurança do OAuth é validado por cookie assinado para continuar válido mesmo se o processo do Render reiniciar durante o login.

## Templates da comunidade

Criar um template salva uma cópia da bio atual, incluindo visual, textos, cores, fundo, links e músicas. Ao aplicar um template, o nome, o texto da bio, os links, o avatar e as músicas da pessoa são preservados; somente os efeitos de formatação da bio do template são aplicados ao texto da bio atual. Métricas e o ID do Discord não são publicados na cópia. Criar, listar, editar, favoritar, excluir e usar templates depende das rotas `/api/templates` do `server.js`. Os templates e favoritos são gravados em `data/store.json`; publique as alterações do backend no Render e do frontend no Netlify para ativar esse recurso no site. O armazenamento local do plano gratuito do Render pode ser apagado quando o serviço reinicia.

## Cores e brilhos do perfil

Cada perfil pode escolher individualmente a cor do nome (inclusive no efeito Hacker), ativar o brilho do nome e ativar um brilho colorido na borda do card. A animação Ondas usa um ritmo contínuo entre as letras e respeita a preferência do navegador por movimento reduzido.

## Chat Geral

O Chat Geral exige login pelo Discord para ler e enviar mensagens. Mensagens de texto, figurinhas próprias do Gnay e os 100 envios mais recentes ficam em `data/store.json`; áudios gravados no navegador são limitados a 10 MB e ficam em `data/chat-audio` enquanto a mensagem permanecer na lista. O servidor só entrega esses áudios a sessões autenticadas. Cada mensagem mostra nome, data, avatar e um painel de perfil com link para a bio e ações de amizade.

Pedidos de amizade podem ser aceitos ou recusados. As DMs só são autorizadas pelo backend enquanto os dois usuários forem amigos; desfazer a amizade apaga o histórico da conversa. Cada conversa mantém no máximo 100 mensagens. É possível compartilhar por DM somente links de templates públicos, sem copiar os dados privados do template. As figurinhas atuais são um conjunto integrado ao Gnay; obter automaticamente as figurinhas dos servidores Discord exigiria um bot com acesso e configuração próprios, não disponíveis pelo login OAuth atual.

Amizades, pedidos pendentes e mensagens privadas são armazenados em `data/store.json`. Publique `server.js` no Render e `index.html` no Netlify para ativar o recurso. O armazenamento local do plano gratuito do Render pode ser apagado quando o serviço reinicia.

### Cargos do servidor no chat

Para consultar os cargos, configure `DISCORD_BOT_TOKEN` no `.env` local e como variável secreta no Render. O bot precisa estar no servidor `1558728880309665845`, ter acesso à lista de membros e a intenção privilegiada **Server Members Intent** habilitada no Discord Developer Portal. No chat, usuários com o cargo `1558728880628441135` aparecem como **Membro**. Quem tiver qualquer um dos cargos `1558728880695681106`, `1559579048609583136`, `1560406584998236160` ou `1558728880683089999` aparece como **Admin** (prioridade sobre Membro). A consulta é feita pelo backend e armazenada em cache por cinco minutos.

### Cópia privada para testar

`local-test/index.html` é uma cópia da página atualmente hospedada para testes. Inicie o servidor isolado com `node server.local-test.js` e abra <http://localhost:8766/local-test>. A cópia entra automaticamente como **Visitante de teste**, sem OAuth do Discord. Os perfis, templates, mensagens e uploads de teste ficam separados em `data/local-test/` e `uploads/local-test/`; não são misturados aos dados do servidor local normal. Esse modo só escuta em `127.0.0.1`, e o endpoint de sessão fictícia só existe nele. O `netlify.toml` também bloqueia `/local-test` no deploy público. Para usar o login Discord normal, continue iniciando `node server.js` e acesse <http://localhost:8765>.

## Prévia de perfil ao compartilhar no Discord

A Edge Function `netlify/edge-functions/profile-preview.ts` usa os dados públicos do backend para montar os metadados Open Graph de cada URL `/<nome>`. O Netlify publica essa função junto com o site; mantenha a rota `/:slug` configurada no `netlify.toml`. O serviço do Render também precisa estar acessível para que o Discord receba nome, bio e avatar corretos. Pré-visualizações que já foram enviadas podem continuar em cache pelo Discord.

As visualizações são contadas uma vez por endereço IP e perfil; recarregar a página não conta novamente, e visitas feitas pelo próprio dono conectado são ignoradas. O backend guarda apenas um HMAC do IP, não o endereço em texto puro. As estatísticas diárias também contam apenas essa primeira visita.

O serviço gratuito do Render usa armazenamento temporário. Bios, templates, arquivos enviados e a lista de IPs já contados podem ser perdidos em uma reinicialização ou novo deploy. Para mantê-los entre deploys, configure armazenamento persistente externo ou um disco persistente do Render; faça backups, pois nenhum armazenamento garante dados “para sempre”.

Integrações como pagamentos, MFA e recursos administrativos continuam dependendo de serviços adicionais.

## Cartão e atividades do Discord

O perfil usa o ID da conta autenticada para exibir o cartão do Discord. Para exibir presença e atividades ao vivo, a conta também precisa entrar no [servidor Lanyard](https://discord.gg/lanyard) e permitir que ele compartilhe a presença. O servidor local consulta a API pública do Lanyard; se a conta não estiver sendo monitorada, o perfil informa como ativar o recurso. A decoração do avatar é atualizada ao entrar pelo Discord. O escopo `identify.premium`, necessário para ler o tipo de assinatura Nitro via OAuth, está restrito pelo Discord a aplicações aprovadas e não é solicitado pelo Gnay. O Discord não fornece um status global de Boost: essa insígnia depende de um servidor específico e não é exibida automaticamente neste site.

## Templates pessoais do perfil

Na categoria **Perfil**, cada conta autenticada pode salvar até 50 templates pessoais e privados. Eles guardam uma cópia das configurações visuais e do conteúdo do perfil, incluindo bio, fundo, links e músicas, e podem ser aplicados ou excluídos depois. O recurso depende das rotas `/api/profile-templates` do backend: publique a versão atualizada de `server.js` no Render e o frontend no Netlify. Se o servidor responder `501`, o backend publicado ainda não tem essas rotas. Os dados ficam em `profileTemplates` no `data/store.json` do backend; faça backup desse arquivo se precisar manter os dados entre reinicializações ou migrações do serviço.

Também é possível baixar o perfil atual ou um template salvo em um arquivo `.template` e importá-lo depois. O arquivo inclui as mídias enviadas ao site; ao importar, elas são enviadas novamente e o perfil restaurado é salvo como um novo template pessoal (não substitui o perfil ativo). Os downloads usam nomes sequenciais como `gnaybiouser.template`, `gnaybiouser.template1` e `gnaybiouser.template2`. Templates pessoais aceitam até 1,5 MB de configurações, além das mídias incluídas no arquivo.
