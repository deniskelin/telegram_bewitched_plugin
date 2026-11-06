import { t } from '../../i18n/index.ts'
export function brokerTypeLabel(type?: string): string {
  switch (type) {
    case 'ACCOUNT_TYPE_TINKOFF':
      return t('Брокерский счёт')
    case 'ACCOUNT_TYPE_TINKOFF_IIS':
      return t('ИИС')
    case 'ACCOUNT_TYPE_INVEST_BOX':
      return t('Инвесткопилка')
    default:
      return t('Другой тип счёта')
  }
}
