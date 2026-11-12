# Distributed Wagering Processor

Solução do desafio Jungle Gaming (veja `spec.md`): API em NestJS rodando em Bun, com PostgreSQL (MikroORM) e SQS local (LocalStack). Idempotência, ledger, inbox e outbox são transacionais no PostgreSQL.

As decisões de projeto e as limitações estão em `ARCHITECTURE.md`.

## Como rodar

Requisitos: Docker Desktop e Bun 1.4.4.

```powershell
bun install --frozen-lockfile
Copy-Item .env.example .env   # só na primeira vez
docker compose up -d --build
Invoke-RestMethod http://localhost:3000/health/ready
```

O Compose sobe PostgreSQL, LocalStack, o setup (migrations, filas e permissões), a API, 3 consumidores, 2 publishers e um worker de referências. A API fica em `http://localhost:3000`.

Para parar e voltar: `docker compose stop` e `docker compose up -d`. O banco persiste entre reinícios. O LocalStack não: depois de recriar o container, rode `docker compose run --rm setup`. Evite `docker compose down -v`, que apaga o banco.

## Testes

```powershell
docker compose --profile test up -d postgres-test localstack
bun run typecheck
bun test
bun run test:integration
```

Os testes de integração usam PostgreSQL e LocalStack reais, com `TEST_DATABASE_URL` apontando para `wagering_test`. Não rode duas suítes de integração ao mesmo tempo.

Com o Compose ativo, `bun run demo` (com `SQS_ENDPOINT=http://localhost:4566`) executa um fluxo completo: aposta concorrente, replay idempotente, REFUND por SQS e reconciliação final. `bun run test:recovery` testa a queda e a volta do PostgreSQL e do LocalStack; rode-o sozinho.

## API

| Método e caminho | Função |
|---|---|
| POST /wallets | Abre carteira |
| GET /wallets/:walletId | Saldo e versão atuais |
| GET /wallets/:walletId/ledger | Ledger paginado por versão |
| POST /wagering/transactions | BET, WIN, LOSS, REFUND ou ROLLBACK |
| GET /wagering/transactions/:transactionId | Estado da operação |
| GET /providers/:providerId/wagering/transactions/:externalTransactionId | Consulta pela identidade do provedor |
| POST /wallets/:walletId/reconciliation | Confere saldo e ledger, sem corrigir |
| GET /health/live, /health/ready | Liveness e readiness |
| GET /metrics | Métricas Prometheus |

O header `Idempotency-Key` é obrigatório em `POST /wagering/transactions`. Valores monetários são strings com duas casas (`"25.00"`), e as moedas aceitas são BRL, USD e EUR.

Status principais: 200/201 sucesso, 202 referência pendente, 400 contrato inválido, 404 não encontrado, 409 conflito de identidade ou payload, 422 rejeição de negócio, 503 infraestrutura indisponível (repita com a mesma chave).

## Filas

- `wager-transactions.fifo`: entrada de operações
- `wager-transactions-dlq.fifo`: mensagens inválidas ou com tentativas esgotadas
- `wager-events.fifo`: eventos da outbox

## Desenvolvimento local

Com apenas as dependências no Docker:

```powershell
docker compose stop api consumer publisher references
bun run migration:up
bun run sqs:init
bun run start:dev
# em terminais separados:
bun run worker:consumer
bun run worker:publisher
bun run worker:references
```

No host, use `SQS_ENDPOINT=http://localhost:4566` no `.env`. As migrations são sempre explícitas; a API não altera o schema ao iniciar.

## Observações

Não há autenticação: o guard no-op é o ponto de extensão previsto pelo desafio. As credenciais do Compose são só para uso local.
