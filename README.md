# review-services-action

Action to handle service's needed for review environment.

## Configuration

Following input variables are used in the action. Values without default value are mandatory.

| Name                    | Description                                                                                                | Default value |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | :-----------: |
| `kubeconfig`            | Kubeconfig as text to allow access to cluster and namespaces (RBAC) to create/get/delete jobs and secrets. |               |
| `namespace`             | Namespace of where application (and job) is deployed to                                                    |               |
| `action`                | What should be done. Possible options `create` and `remove`                                                |    create     |
| `default_database_name` | Name of the database that exists in postgres, as `psql` have to connect to DB before can create one        |   defaultdb   |
| `database`              | Name of the database to create                                                                             |               |
| `db_user`               | Admin user of database that can *create* and *drop* databases                                              |      ""       |
| `db_password`           | Password of admin user                                                                                     |               |
| `db_host`               | psql host                                                                                                  |               |
| `db_port`               | post that Postgres answers from                                                                            |               |

## Other options

### [kolga-deploy-service-action](https://github.com/andersinno/kolga-deploy-service-action)

Deploy-service-action deploys service in own container, once per namespace and service needed. It also creates persistent volume for the service (if applicable).

#### Cons
- Persistent volume is bound to zone, so if pod is evicted it has to be able to get to same zone or it's not started
- Amount of volumes and extra resource usage can get high if there's multiple PR open
- Different approach than with other environments
- No support for multiple DB in namespace (which might happen e.g. with monorepos)

#### Pros
- Doesn't require separate database accessible from cluster
- Removed along review environment
