import type { Presentation } from '../shared/presentation.ts';

export interface FlightSearchRequest {
  searches: Array<{ from: string[]; to: string[]; date: string; returnDate?: string }>;
  adults: number;
  children: number;
  infants: number;
  cabin: 'economy' | 'premium_economy' | 'business' | 'first';
  maxStops?: number;
  currency: string;
  language: string;
  first?: number;
}

export type FlightOption = Extract<Presentation, { type: 'flights' }>['options'][number];

export interface FlightSearchResult {
  searchedAt: string;
  travellers: string;
  searches: Array<
    { label: string; url: string } & (
      | {
          note?: string;
          upperBound?: boolean;
          cheapest?: string;
          options: Array<{ summary: string; option: FlightOption; amount?: number }>;
        }
      | { error: string }
    )
  >;
}

export interface FlightSearch {
  search(request: FlightSearchRequest, signal: AbortSignal): Promise<FlightSearchResult>;
}
