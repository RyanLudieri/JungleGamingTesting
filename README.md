# Distributed Wagering Processor

Implementação do desafio Jungle Gaming descrito em `spec.md`: API NestJS, Bun, PostgreSQL/MikroORM e SQS local, com idempotência, ledger, inbox e outbox transacionais.

## Executar tudo

Requisitos: Docker Desktop aberto (Linux containers/WSL2) e Bun 1.4.4 para executar testes no host.

```powershell
bun install --frozen-lockfile
# Apenas na primeira execução, se .env ainda não existir:
Copy-Item .env.example .env
docker compose up -d --build
Invoke-RestMethod http://localhost:3000/health/ready
```

Compose sobe PostgreSQL, LocalStack, setup de migrations/filas/permissões, API, **3 consumidores**, **2 publishers** e um worker de referências. A API está em http://localhost:3000. Não existe interface gráfica; este projeto é um serviço HTTP e de mensageria.

As credenciais no Compose são exclusivamente locais. O processo `setup` usa o proprietário do banco; os serviços usam `wagering_app`, sem DELETE/TRUNCATE e sem permissão de alteração do ledger. A aplicação roda como usuário não root no container. As portas públicas estão vinculadas a 127.0.0.1.

```powershell
docker compose ps
docker compose logs --tail 100 api consumer publisher references
docker compose stop
# Para voltar a executar:
docker compose up -d
```

O volume PostgreSQL preserva os dados entre reinícios. O LocalStack Community deste ambiente é efêmero: após recriar seu container, execute `docker compose run --rm setup` para recriar as filas. Mensagens já publicadas no emulador não são backup; este comportamento local é diferente da persistência de SQS na AWS. Não execute `docker compose down -v` se quiser preservar o banco.

## Testar

```powershell
docker compose --profile test up -d postgres-test localstack
bun run typecheck
bun test
bun run test:integration
```

Os testes de integração exigem `TEST_DATABASE_URL` apontando para **wagering_test**, diferente de `DATABASE_URL`. Eles usam PostgreSQL e LocalStack reais; criam schemas/filas temporários e removem somente esses recursos ao terminar. O banco de testes usa tmpfs e não guarda dados entre reinícios do container. Não execute duas suítes de integração simultaneamente: a suíte de migrations usa o schema public do banco de testes.

Cobertura: dinheiro exato; constraints e migrations; concorrência de 50 pedidos; disputa de saldo; reversões e referências antecipadas; rollback de inbox/outbox; API; dois publishers; três processos consumidores; morte após commit antes de ack; retries, DLQ e FAILED; deduplicação do consumidor de eventos; reconciliação final.

Demonstração completa, com a aplicação Compose ativa:

```powershell
$env:SQS_ENDPOINT='http://localhost:4566'
bun run demo
```

Cria uma carteira de 100.00, disputa duas apostas de 80.00, verifica os HTTP 200/422, repete a aposta vencedora e envia REFUND por SQS. Ao final imprime saldo 100.00, diferença 0.00 e `consistent: true`. Cada execução cria uma nova carteira de demonstração.

Teste opcional de indisponibilidade real: `bun run test:recovery`. Ele para e reinicia os containers **locais** de PostgreSQL e LocalStack, cria uma carteira de demonstração e valida liveness/readiness, preservação da outbox, replay após restart e reconciliação. Execute sozinho, sem outras suítes em andamento. O script restaura os serviços em blocos `finally`.

## API

| Método e caminho | Função |
|---|---|
| POST /wallets | Abre carteira; saldo positivo gera OPENING e ledger na mesma transação |
| GET /wallets/:walletId | Saldo e versão atuais |
| GET /wallets/:walletId/ledger?limit=50&cursor=... | Ledger ordenado por versão; limite 1..200 |
| POST /wagering/transactions | BET, WIN, LOSS, REFUND ou ROLLBACK |
| GET /wagering/transactions/:transactionId | Estado atual da operação |
| GET /providers/:providerId/wagering/transactions/:externalTransactionId | Consulta pela identidade do provedor |
| POST /wallets/:walletId/reconciliation | Confere saldo e ledger sob lock, sem corrigir divergências |
| GET /health/live | Processo vivo |
| GET /health/ready | PostgreSQL e filas de entrada/eventos alcançáveis |
| GET /metrics | Métricas em formato texto Prometheus |

```powershell
$wallet = Invoke-RestMethod -Method Post -Uri http://localhost:3000/wallets -ContentType application/json -Body (@{
  playerId=[guid]::NewGuid().ToString()
  initialBalance=@{amount='100.00';currency='BRL'}
} | ConvertTo-Json)
$transaction = [guid]::NewGuid().ToString()
$body = @{
  providerId='provider-a'; externalTransactionId=$transaction
  walletId=$wallet.id; playerId=$wallet.playerId
  roundId='round-1'; gameId='game-1'; kind='BET'
  money=@{amount='25.00';currency='BRL'}
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3000/wagering/transactions -Headers @{'Idempotency-Key'="provider-a:$transaction"} -ContentType application/json -Body $body
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/wallets/$($wallet.id)/reconciliation"
```

Repita exatamente o último pedido de aposta e a mesma chave para verificar `idempotentReplay: true`. O header é obrigatório e prevalece sobre qualquer campo `idempotencyKey` no corpo HTTP. Valores monetários são strings com exatamente duas casas. `OPENING` é interno. Carteiras aceitam BRL, USD e EUR; operações não convertem moedas.

| HTTP | Significado |
|---|---|
| 200 / 201 | Consulta/operação processada; carteira criada |
| 202 | Referência pendente |
| 400 | Contrato inválido |
| 404 | Recurso consultado não encontrado |
| 409 | Identidade/chave com payload divergente ou carteira duplicada |
| 422 | Rejeição de negócio auditada |
| 500 | Replay de FAILED terminal, com failureCode |
| 503 | Infraestrutura indisponível; repetir com a mesma chave |

A submissão com wallet inexistente é payload inválido (400). Consultar wallet inexistente retorna 404. O replay devolve o resultado **original**, inclusive saldo e aceite pendente; GET devolve o estado **atual** após o worker processar uma referência.

## Filas e operação

- `wager-transactions.fifo`: envelope de entrada conforme `spec.md`.
- `wager-transactions-dlq.fifo`: mensagens inválidas, conflitantes ou com tentativas esgotadas.
- `wager-events.fifo`: eventos da outbox, com `eventId` estável.

`bun run sqs:init` cria as filas locais. Envie `MessageGroupId=walletId` e um `MessageDeduplicationId` por envio. Essas facilidades do broker não substituem a proteção no PostgreSQL.

Para inspecionar a DLQ sem remover mensagens:

```powershell
docker compose exec localstack awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo
# Use a QueueUrl retornada:
docker compose exec localstack awslocal sqs receive-message --queue-url '<QueueUrl>' --max-number-of-messages 10 --message-attribute-names All
```

Investigue a causa antes de redrive. Reenvie com a identidade original para recuperar o resultado persistido; FAILED é terminal e não deve ser alterado para reaplicar dinheiro. Uma operação substituta exige decisão de negócio explícita e nova identidade. Durante indisponibilidade prolongada do banco, o redrive nativo do SQS preserva a mensagem na DLQ, mas não é possível gravar FAILED enquanto o banco está inacessível; a DLQ é a evidência operacional nesse caso.

Os workers expõem métricas na porta 9100 **dentro da rede Docker** (`METRICS_PORT`). Colete cada réplica para obter os contadores de retries, duplicatas, DLQ e latência. A API expõe seu próprio processo e o lag global da outbox; contadores em memória reiniciam com o processo. Logs JSON não incluem valores monetários ou payloads completos.

## Desenvolvimento sem containers da aplicação

Mantenha apenas as dependências Docker ativas e pare API/workers Compose para evitar disputa pela porta 3000:

```powershell
docker compose stop api consumer publisher references
bun run migration:up
bun run sqs:init
bun run start:dev
# Em terminais separados:
bun run worker:consumer
bun run worker:publisher
bun run worker:references
```

Bun carrega `.env`. No host, confirme `SQS_ENDPOINT=http://localhost:4566`. Migrations são explícitas (`migration:up` / `migration:down`); a API nunca muda o schema ao iniciar. Rollbacks que descartariam histórico financeiro/inbox são recusados. `REFERENCE_TTL_MS` padrão: 900000; backoff de 1s a 60s; polling 500ms.

## Entrega

Veja `ARCHITECTURE.md` para decisões e limitações. `.env`, node_modules, snapshots de migrations e logs estão ignorados pelo Git. Revise o projeto antes da publicação no GitHub. Não há autenticação de produção configurada: o guard no-op é o ponto de extensão explícito permitido pelo desafio.
