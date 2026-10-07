export interface QboQueryResponse<T> {
  QueryResponse: {
    startPosition?: number;
    maxResults?: number;
    totalCount?: number;
    Customer?: T[];
    Invoice?: T[];
    Payment?: T[];
    Account?: T[];
    CreditMemo?: T[];
  };
  time: string;
}

export const QBO_CDC_ENTITIES = ['Customer', 'Account', 'Invoice', 'Payment'] as const;
export type QboCdcEntity = typeof QBO_CDC_ENTITIES[number];

export interface QboCdcQueryResponse {
  Customer?: unknown[];
  Account?: unknown[];
  Invoice?: unknown[];
  Payment?: unknown[];
  startPosition?: number;
  maxResults?: number;
  totalCount?: number;
}

export interface QboCdcGroup {
  QueryResponse: QboCdcQueryResponse[];
}

export interface QboCdcResponse {
  CDCResponse: QboCdcGroup[];
  time: string;
}

export interface QboCompanyInfo {
  CompanyName?: string;
  LegalName?: string;
  CompanyAddr?: {
    Line1?: string;
    City?: string;
    CountrySubDivisionCode?: string;
    PostalCode?: string;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  CustomerCommunicationAddr?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  LegalAddr?: any;
  PrimaryPhone?: {
    FreeFormNumber?: string;
  };
  CompanyStartDate?: string;
  EmployerId?: string;
  FiscalYearStartMonth?: string;
  Country?: string;
  Email?: {
    Address?: string;
  };
  WebAddr?: {
    URI?: string;
  };
  SupportedLanguages?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  NameValue?: any[];
  domain?: string;
  sparse?: boolean;
  Id?: string;
  SyncToken?: string;
  MetaData?: {
    CreateTime?: string;
    LastUpdatedTime?: string;
  };
}

export interface QboCustomer {
  Taxable?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  BillAddr?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ShipAddr?: any;
  Job?: boolean;
  BillWithParent?: boolean;
  Balance?: number;
  BalanceWithJobs?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  CurrencyRef?: any;
  PreferredDeliveryMethod?: string;
  domain?: string;
  sparse?: boolean;
  Id?: string;
  SyncToken?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  MetaData?: any;
  FullyQualifiedName?: string;
  CompanyName?: string;
  DisplayName?: string;
  PrintOnCheckName?: string;
  Active?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PrimaryPhone?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PrimaryEmailAddr?: any;
}

export interface QboInvoice {
  Deposit?: number;
  AllowIPNPayment?: boolean;
  AllowOnlinePayment?: boolean;
  AllowOnlineCreditCardPayment?: boolean;
  AllowOnlineACHPayment?: boolean;
  domain?: string;
  sparse?: boolean;
  Id?: string;
  SyncToken?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  MetaData?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  CustomField?: any[];
  DocNumber?: string;
  TxnDate?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  CurrencyRef?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  LinkedTxn?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Line?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TxnTaxDetail?: any;
  CustomerRef?: {
    value: string;
    name?: string;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  CustomerMemo?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  BillAddr?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ShipAddr?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  SalesTermRef?: any;
  DueDate?: string;
  TotalAmt?: number;
  ApplyTaxAfterDiscount?: boolean;
  PrintStatus?: string;
  EmailStatus?: string;
  Balance?: number;
}

export interface QboPayment {
  TotalAmt?: number;
  UnappliedAmt?: number;
  ProcessPayment?: boolean;
  domain?: string;
  sparse?: boolean;
  Id?: string;
  SyncToken?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  MetaData?: any;
  TxnDate?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  CurrencyRef?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Line?: any[];
  CustomerRef?: {
    value: string;
    name?: string;
  };
}

export interface QboCreditMemo {
  domain?: string;
  sparse?: boolean;
  Id?: string;
  SyncToken?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  MetaData?: any;
  DocNumber?: string;
  TxnDate?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  CurrencyRef?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Line?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TxnTaxDetail?: any;
  CustomerRef?: {
    value: string;
    name?: string;
  };
  TotalAmt?: number;
  // Unapplied/unused credit remaining on this memo - the credit-memo
  // equivalent of an invoice's Balance.
  RemainingCredit?: number;
  PrintStatus?: string;
  EmailStatus?: string;
}

export interface QboAccount {
  Name?: string;
  SubAccount?: boolean;
  FullyQualifiedName?: string;
  Active?: boolean;
  Classification?: string;
  AccountType?: string;
  AccountSubType?: string;
  CurrentBalance?: number;
  CurrentBalanceWithSubAccounts?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  CurrencyRef?: any;
  domain?: string;
  sparse?: boolean;
  Id?: string;
  SyncToken?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  MetaData?: any;
}
